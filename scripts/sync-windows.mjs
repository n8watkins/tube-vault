import { cp, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isAbsolute as isWindowsAbsolute } from 'node:path/win32';
import { isAbsolute as isPosixAbsolute, normalize as normalizePosix } from 'node:path/posix';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TRANSACTION_PREFIX = '.tube-vault-sync-';
const LOCK_NAME = '.tube-vault-sync.lock';
const LOCK_INTENT_PREFIX = `${LOCK_NAME}.intent-`;
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

async function requireSafeTransactionPath(transactionRoot, relativePath = '') {
  const canonicalRoot = await realpath(transactionRoot);
  if (canonicalRoot !== resolve(transactionRoot)) throw new Error(`Sync transaction cannot be a symbolic link: ${transactionRoot}`);

  let current = canonicalRoot;
  for (const segment of relativePath.split('/').filter(Boolean)) {
    current = join(current, segment);
    const info = await lstat(current).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error(`Sync transaction path cannot contain a symbolic link: ${current}`);
    const canonicalPath = await realpath(current);
    if (!isWithinRoot(canonicalRoot, canonicalPath)) {
      throw new Error(`Sync transaction path escapes its root: ${current}`);
    }
  }
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

async function syncFile(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function mkdirDurably(path) {
  const missing = [];
  let current = resolve(path);
  while (!await pathExists(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const existing = await lstat(current);
  if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error(`Sync directory path is unsafe: ${current}`);
  for (const created of missing.reverse()) await mutateDurably([created], () => mkdir(created));
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openStableDirectory(path) {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`Sync mutation parent is unsafe: ${path}`);
  const handle = await open(path, 'r');
  const opened = await handle.stat();
  const after = await lstat(path);
  if (!after.isDirectory() || after.isSymbolicLink() || !sameFile(before, opened) || !sameFile(opened, after)) {
    await handle.close();
    throw new Error(`Sync mutation parent changed concurrently: ${path}`);
  }
  return { handle, identity: opened, path };
}

async function requireStableDirectory(directory) {
  const current = await lstat(directory.path);
  const opened = await directory.handle.stat();
  if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(directory.identity, opened) || !sameFile(opened, current)) {
    throw new Error(`Sync mutation parent changed concurrently: ${directory.path}`);
  }
}

async function mutateDurably(paths, mutation) {
  const directories = [];
  try {
    for (const path of [...new Set(paths.map((entry) => dirname(entry)))]) directories.push(await openStableDirectory(path));
    for (const directory of directories) await requireStableDirectory(directory);
    await mutation();
    for (const directory of directories) await requireStableDirectory(directory);
    for (const directory of directories) await directory.handle.sync().catch((error) => {
      if (!error?.code || !DIRECTORY_SYNC_UNAVAILABLE_CODES.has(error.code)) throw error;
    });
  } finally {
    await Promise.all(directories.map(({ handle }) => handle.close()));
  }
}

async function removeDurably(path, options = {}) {
  if (!await pathExists(path)) return;
  await mutateDurably([path], () => rm(path, options));
}

async function writeJournalDurably(transactionRoot, entries, state = 'pending') {
  const journalPath = join(transactionRoot, 'journal.json');
  const temporaryPath = join(transactionRoot, 'journal.json.tmp');
  let handle;
  try {
    handle = await open(temporaryPath, 'wx');
    await handle.writeFile(`${JSON.stringify({ state, entries }, null, 2)}\n`);
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

async function ownerIsAlive(owner, localOwner) {
  if (owner.hostname !== localOwner.hostname) return true;
  const existingIdentity = await readProcessIdentity(owner.pid);
  return typeof owner.processIdentity === 'string' && existingIdentity !== undefined
    ? owner.processIdentity === existingIdentity
    : processIsAlive(owner.pid);
}

async function claimLockIntent(target, ownerPath, owner) {
  const ownerName = ownerPath.slice(target.length + 1);
  for (const name of await readdir(target)) {
    if (!name.startsWith(LOCK_INTENT_PREFIX) || name === ownerName) continue;
    const contenderPath = join(target, name);
    const contender = await readLockOwner(contenderPath);
    if (await ownerIsAlive(contender, owner)) {
      throw new Error(`Another sync is already running for target: ${target}`);
    }
    const confirmedContender = await readLockOwner(contenderPath);
    if (confirmedContender.token === contender.token) await unlink(contenderPath);
  }
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
  const ownerPath = join(target, `${LOCK_INTENT_PREFIX}${token}`);
  let ownerHandle;
  let acquired = false;
  try {
    ownerHandle = await open(ownerPath, 'wx');
    await ownerHandle.writeFile(`${JSON.stringify(owner)}\n`);
    await ownerHandle.sync();
    await ownerHandle.close();
    ownerHandle = undefined;
    await syncDirectory(target);
    await claimLockIntent(target, ownerPath, owner);

    while (true) {
      try {
        await link(ownerPath, lockPath);
        await syncDirectory(target);
        acquired = true;
        return async () => {
          try {
            const currentOwner = await readLockOwner(lockPath).catch(() => null);
            if (currentOwner?.token === token) {
              await unlink(lockPath);
              await syncDirectory(target);
            }
          } finally {
            await rm(ownerPath, { force: true });
            await syncDirectory(target);
          }
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existingOwner = await readLockOwner(lockPath);
        if (await ownerIsAlive(existingOwner, owner)) {
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
        await hooks.afterReclaimClaim?.(existingOwner);
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
    if (!acquired) await rm(ownerPath, { force: true });
  }
}

async function restoreTransaction(target, transactionRoot, entries) {
  for (const entry of [...entries].reverse()) {
    await requireSafeTargetPath(target, entry.relativePath);
    await requireSafeTransactionPath(transactionRoot, `files/${entry.relativePath}`);
    await requireSafeTransactionPath(transactionRoot, `backups/${entry.relativePath}`);
    const destination = join(target, entry.relativePath);
    const staged = join(transactionRoot, 'files', entry.relativePath);
    const backup = join(transactionRoot, 'backups', entry.relativePath);
    const installed = !await pathExists(staged);
    if (entry.existed && await pathExists(backup)) {
      if (await pathExists(destination)) await removeDurably(destination, { force: true });
      await mkdirDurably(resolve(destination, '..'));
      await requireSafeTargetPath(target, entry.relativePath);
      await requireSafeTransactionPath(transactionRoot, `backups/${entry.relativePath}`);
      await mutateDurably([backup, destination], () => rename(backup, destination));
    } else if (!entry.existed && installed && await pathExists(destination)) {
      await removeDurably(destination, { force: true });
    }
  }
}

export async function recoverSyncTransactions(target) {
  const names = await readdir(target);
  for (const name of names.filter((entry) => entry.startsWith(TRANSACTION_PREFIX))) {
    const transactionRoot = join(target, name);
    const info = await lstat(transactionRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    await requireSafeTransactionPath(transactionRoot);
    const journalPath = join(transactionRoot, 'journal.json');
    if (await pathExists(journalPath)) {
      await requireSafeTransactionPath(transactionRoot, 'journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      if (!journal || typeof journal !== 'object' || !['pending', 'committed'].includes(journal.state ?? 'pending')) {
        throw new Error(`Invalid sync transaction journal: ${journalPath}`);
      }
      const entries = validateEntries(journal.entries, journalPath);
      if (journal.state !== 'committed') await restoreTransaction(target, transactionRoot, entries);
    }
    await removeDurably(transactionRoot, { recursive: true, force: true });
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
    await syncDirectory(target);
    const entries = [];
    let removeTransaction = false;
    try {
      for (const { relativePath } of requestedEntries) {
        const staged = join(transactionRoot, 'files', relativePath);
        await mkdirDurably(resolve(staged, '..'));
        await cp(join(sourceRoot, relativePath), staged);
        await syncFile(staged);
        await syncDirectory(dirname(staged));
        entries.push({ relativePath, existed: await pathExists(join(target, relativePath)) });
      }
      await writeJournalDurably(transactionRoot, entries);

      try {
        for (const [index, entry] of entries.entries()) {
          await hooks.beforeInstall?.(entry.relativePath, index);
          await requireSafeTargetPath(target, entry.relativePath);
          const destination = join(target, entry.relativePath);
          const staged = join(transactionRoot, 'files', entry.relativePath);
          await requireSafeTransactionPath(transactionRoot, `files/${entry.relativePath}`);
          if (entry.existed) {
            const backup = join(transactionRoot, 'backups', entry.relativePath);
            await mkdirDurably(resolve(backup, '..'));
            await requireSafeTargetPath(target, entry.relativePath);
            await requireSafeTransactionPath(transactionRoot, `backups/${entry.relativePath}`);
            await syncFile(destination);
            await mutateDurably([destination, backup], () => rename(destination, backup));
          } else {
            await mkdirDurably(resolve(destination, '..'));
          }
          await requireSafeTargetPath(target, entry.relativePath);
          await requireSafeTransactionPath(transactionRoot, `files/${entry.relativePath}`);
          await mutateDurably([staged, destination], () => rename(staged, destination));
        }
      } catch (error) {
        try {
          await restoreTransaction(target, transactionRoot, entries);
          removeTransaction = true;
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Artifact sync and rollback both failed', { cause: error });
        }
        throw error;
      }
      await writeJournalDurably(transactionRoot, entries, 'committed');
      removeTransaction = true;
    } finally {
      if (removeTransaction) await removeDurably(transactionRoot, { recursive: true, force: true });
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
