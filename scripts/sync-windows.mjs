import { cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isAbsolute as isWindowsAbsolute } from 'node:path/win32';
import { isAbsolute as isPosixAbsolute, normalize as normalizePosix } from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TRANSACTION_PREFIX = '.tube-vault-sync-';
const LOCK_NAME = '.tube-vault-sync.lock';
const DIRECTORY_SYNC_UNAVAILABLE_CODES = new Set(['EACCES', 'EPERM', 'EINVAL', 'EBADF', 'EISDIR', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);

export const SYNC_FILES = [
  'extension/manifest.json',
  'extension/popup.html',
  'extension/options.html',
  'extension/icons/icon16.png',
  'extension/icons/icon32.png',
  'extension/icons/icon48.png',
  'extension/icons/icon128.png',
  'extension/dist/content-script.js',
  'extension/dist/service-worker.js',
  'extension/dist/popup.js',
  'extension/dist/options.js',
  'helper/dist/downloader.js',
  'helper/dist/index.js',
  'helper/dist/protocol.js',
  'helper/dist/sanitize.js',
  'helper/package.json',
  'helper/package-lock.json',
];

export function targetArgument(argv) {
  const index = argv.indexOf('--target');
  if (index === -1) return undefined;
  if (!argv[index + 1]) throw new Error('--target requires a repository path');
  return argv[index + 1];
}

async function requireDirectory(path, description) {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`${description} does not exist: ${path}`);
}

async function readJson(path, description) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`${description} is missing or invalid: ${path}`);
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function isWithinRoot(root, path) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}

async function requireSafeTargetPath(target, relativePath = '') {
  const canonicalTarget = await realpath(target);
  if (canonicalTarget !== resolve(target)) throw new Error(`Sync target cannot be a symbolic link: ${target}`);

  let current = canonicalTarget;
  for (const segment of relativePath.split('/').filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error(`Sync target path cannot contain a symbolic link: ${current}`);
    const canonicalPath = await realpath(current);
    if (!isWithinRoot(canonicalTarget, canonicalPath)) {
      throw new Error(`Sync target path escapes the repository: ${current}`);
    }
  }
  return canonicalTarget;
}

async function requireSafeArtifactPaths(target, entries) {
  for (const { relativePath } of entries) await requireSafeTargetPath(target, relativePath);
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (error?.code && DIRECTORY_SYNC_UNAVAILABLE_CODES.has(error.code)) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    if (!error?.code || !DIRECTORY_SYNC_UNAVAILABLE_CODES.has(error.code)) throw error;
  } finally {
    await handle.close();
  }
}

async function writeJournalDurably(transactionRoot, entries) {
  const journalPath = join(transactionRoot, 'journal.json');
  const temporaryPath = join(transactionRoot, 'journal.json.tmp');
  let handle;
  try {
    handle = await open(temporaryPath, 'wx');
    await handle.writeFile(`${JSON.stringify({ entries }, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, journalPath);
    await syncDirectory(transactionRoot);
  } finally {
    if (handle) await handle.close();
    await rm(temporaryPath, { force: true });
  }
}

function validateRelativePath(relativePath) {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath.includes('\\')
    || isPosixAbsolute(relativePath)
    || isWindowsAbsolute(relativePath)
    || normalizePosix(relativePath) !== relativePath
    || relativePath === '..'
    || relativePath.startsWith('../')
  ) {
    throw new Error(`Invalid sync artifact path: ${String(relativePath)}`);
  }
  return relativePath;
}

function validateEntries(entries, description) {
  if (!Array.isArray(entries)) throw new Error(`Invalid sync transaction journal: ${description}`);
  const allowedPaths = new Set(SYNC_FILES.map(validateRelativePath));
  const seenPaths = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid sync transaction journal entry: ${description}`);
    }
    const relativePath = validateRelativePath(entry.relativePath);
    if (!allowedPaths.has(relativePath) || seenPaths.has(relativePath) || typeof entry.existed !== 'boolean') {
      throw new Error(`Invalid sync transaction journal entry: ${description}`);
    }
    seenPaths.add(relativePath);
    return { relativePath, existed: entry.existed };
  });
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

export async function readProcessIdentity(pid, platform = process.platform) {
  try {
    if (platform === 'darwin') {
      const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const started = result.status === 0 ? result.stdout.trim() : '';
      return started ? `darwin:${started}` : undefined;
    }
    if (platform !== 'linux') return undefined;
    const processStat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = processStat.slice(processStat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ? `linux:${fields[19]}` : undefined;
  } catch {
    return undefined;
  }
}

async function readLockOwner(lockPath) {
  let owner;
  try {
    owner = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    throw new Error(`Sync lock is invalid: ${lockPath}`);
  }
  if (
    !owner
    || typeof owner !== 'object'
    || !Number.isSafeInteger(owner.pid)
    || owner.pid <= 0
    || typeof owner.hostname !== 'string'
    || typeof owner.token !== 'string'
    || (owner.processIdentity !== undefined && (typeof owner.processIdentity !== 'string' || owner.processIdentity.length === 0))
  ) {
    throw new Error(`Sync lock is invalid: ${lockPath}`);
  }
  return owner;
}

async function restoreClaimedLock(claimPath, lockPath) {
  try {
    await link(claimPath, lockPath);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await unlink(claimPath);
}

async function acquireSyncLock(target, hooks = {}) {
  const lockPath = join(target, LOCK_NAME);
  const token = randomUUID();
  const owner = {
    pid: process.pid,
    hostname: hostname(),
    token,
    processIdentity: await readProcessIdentity(process.pid),
  };
  const ownerPath = join(target, `${LOCK_NAME}.${token}`);
  let ownerHandle;
  try {
    ownerHandle = await open(ownerPath, 'wx');
    await ownerHandle.writeFile(`${JSON.stringify(owner)}\n`);
    await ownerHandle.sync();
    await ownerHandle.close();
    ownerHandle = undefined;

    while (true) {
      try {
        await link(ownerPath, lockPath);
        await unlink(ownerPath);
        await syncDirectory(target);
        return async () => {
          const currentOwner = await readLockOwner(lockPath).catch(() => null);
          if (currentOwner?.token === token) {
            await unlink(lockPath);
            await syncDirectory(target);
          }
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existingOwner = await readLockOwner(lockPath);
        const existingIdentity = await readProcessIdentity(existingOwner.pid);
        const ownerIsAlive = typeof existingOwner.processIdentity === 'string' && existingIdentity !== undefined
          ? existingOwner.processIdentity === existingIdentity
          : processIsAlive(existingOwner.pid);
        if (existingOwner.hostname !== owner.hostname || ownerIsAlive) {
          throw new Error(`Another sync is already running for target: ${target}`);
        }
        const confirmedOwner = await readLockOwner(lockPath);
        if (confirmedOwner.token !== existingOwner.token) continue;
        await hooks.beforeReclaim?.(existingOwner);
        const claimPath = join(target, `${LOCK_NAME}.reclaim-${token}-${randomUUID()}`);
        try {
          await rename(lockPath, claimPath);
        } catch (claimError) {
          if (claimError?.code === 'ENOENT') continue;
          throw claimError;
        }
        const claimedOwner = await readLockOwner(claimPath).catch(() => null);
        if (claimedOwner?.token !== existingOwner.token) {
          await restoreClaimedLock(claimPath, lockPath);
          continue;
        }
        await unlink(claimPath);
      }
    }
  } finally {
    if (ownerHandle) await ownerHandle.close();
    await rm(ownerPath, { force: true });
  }
}

async function restoreTransaction(target, transactionRoot, entries) {
  for (const entry of [...entries].reverse()) {
    await requireSafeTargetPath(target, entry.relativePath);
    const destination = join(target, entry.relativePath);
    const staged = join(transactionRoot, 'files', entry.relativePath);
    const backup = join(transactionRoot, 'backups', entry.relativePath);
    const installed = !await pathExists(staged);
    if (entry.existed && await pathExists(backup)) {
      if (await pathExists(destination)) await rm(destination, { force: true });
      await mkdir(resolve(destination, '..'), { recursive: true });
      await rename(backup, destination);
    } else if (!entry.existed && installed && await pathExists(destination)) {
      await rm(destination, { force: true });
    }
  }
}

export async function recoverSyncTransactions(target) {
  const names = await readdir(target);
  for (const name of names.filter((entry) => entry.startsWith(TRANSACTION_PREFIX))) {
    const transactionRoot = join(target, name);
    const info = await lstat(transactionRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const journalPath = join(transactionRoot, 'journal.json');
    if (await pathExists(journalPath)) {
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      await restoreTransaction(target, transactionRoot, validateEntries(journal.entries, journalPath));
    }
    await rm(transactionRoot, { recursive: true, force: true });
  }
}

export async function syncArtifacts(sourceRoot, target, files = SYNC_FILES, hooks = {}) {
  const requestedEntries = validateEntries(
    files.map((relativePath) => ({ relativePath, existed: false })),
    'requested artifact list',
  );
  await requireSafeArtifactPaths(target, requestedEntries);
  const releaseLock = await acquireSyncLock(target, hooks);
  try {
    await recoverSyncTransactions(target);
    await requireSafeArtifactPaths(target, requestedEntries);
    const transactionRoot = await mkdtemp(join(target, TRANSACTION_PREFIX));
    const entries = [];
    let removeTransaction = false;
    try {
      for (const { relativePath } of requestedEntries) {
        const staged = join(transactionRoot, 'files', relativePath);
        await mkdir(resolve(staged, '..'), { recursive: true });
        await cp(join(sourceRoot, relativePath), staged);
        entries.push({ relativePath, existed: await pathExists(join(target, relativePath)) });
      }
      await writeJournalDurably(transactionRoot, entries);

      for (const [index, entry] of entries.entries()) {
        await hooks.beforeInstall?.(entry.relativePath, index);
        await requireSafeTargetPath(target, entry.relativePath);
        const destination = join(target, entry.relativePath);
        const staged = join(transactionRoot, 'files', entry.relativePath);
        if (entry.existed) {
          const backup = join(transactionRoot, 'backups', entry.relativePath);
          await mkdir(resolve(backup, '..'), { recursive: true });
          await rename(destination, backup);
        } else {
          await mkdir(resolve(destination, '..'), { recursive: true });
        }
        await rename(staged, destination);
      }
      removeTransaction = true;
    } catch (error) {
      try {
        await restoreTransaction(target, transactionRoot, entries);
        removeTransaction = true;
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Artifact sync and rollback both failed', { cause: error });
      }
      throw error;
    } finally {
      if (removeTransaction) await rm(transactionRoot, { recursive: true, force: true });
    }
  } finally {
    await releaseLock();
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 1}`);
  return result;
}

export async function validateTarget(requestedTarget) {
  if (!requestedTarget) throw new Error('Provide --target <repo-path> or set TUBE_VAULT_WINDOWS_REPO');
  if (!isAbsolute(requestedTarget)) throw new Error(`Sync target must be absolute: ${requestedTarget}`);

  const target = resolve(requestedTarget);
  await requireDirectory(target, 'Sync target');
  await requireSafeTargetPath(target);
  await requireDirectory(join(target, 'extension'), 'Target extension directory');
  await requireDirectory(join(target, 'helper'), 'Target helper directory');
  await requireSafeTargetPath(target, 'extension');
  await requireSafeTargetPath(target, 'helper');

  const gitRootResult = spawnSync('git', ['-C', target, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const gitRoot = gitRootResult.status === 0 ? resolve(gitRootResult.stdout.trim()) : '';
  if (gitRoot !== target) throw new Error(`Sync target must be the root of a Git repository: ${target}`);

  const extensionPackage = await readJson(join(target, 'extension/package.json'), 'Target extension package');
  const manifest = await readJson(join(target, 'extension/manifest.json'), 'Target extension manifest');
  const helperPackage = await readJson(join(target, 'helper/package.json'), 'Target helper package');
  if (extensionPackage.name !== 'tube-vault-extension' || manifest.name !== 'TubeVault' || helperPackage.name !== 'tube-vault-helper') {
    throw new Error(`Sync target is not a TubeVault repository: ${target}`);
  }
  await requireSafeArtifactPaths(target, SYNC_FILES.map((relativePath) => ({ relativePath })));
  return target;
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const target = await validateTarget(targetArgument(argv) ?? environment.TUBE_VAULT_WINDOWS_REPO);
  run('npm', ['run', 'build']);
  await syncArtifacts(repoRoot, target);
  for (const relativePath of SYNC_FILES) {
    console.log(`Copied ${relativePath}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await main();
}
