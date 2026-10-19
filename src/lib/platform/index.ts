/**
 * lib/platform — 平台适配层（唯一允许出现平台差异的地方）
 *
 * 业务代码只应从这里读 `PLATFORM` / 能力表，**不得直接写 `process.platform` 分支**。
 * 目的不是「整洁」，而是让跨平台缺口可被一条探针查出来：
 *   `grep -rn "process.platform" src --exclude-dir=lib/platform` 应当为空。
 *
 * 该目录只允许相对导入（tsup 会把它编进 electron/dist 供主进程使用）。
 */

export {
  PLATFORM,
  IS_WIN,
  IS_DARWIN,
  PATH_DELIMITER,
  pathKey,
  fsPathKey,
  CASE_INSENSITIVE_FS,
  caseInsensitiveFs,
  splitPathList,
  dedupePaths,
  joinPathList,
  exeName,
  POSIX_TOOLCHAIN_DIRS,
  POSIX_SYSTEM_DIRS,
  windowsBinDirs,
  baseBinDirs,
  type PlatformId,
} from './runtime';

export {
  parseLsofPids,
  parseNetstatListenPids,
  parsePsByCommandPrefix,
  parseLsofCwdPids,
  parseCimProcessJson,
  filterCimByCommandLine,
  parseSinglePid,
  encodePowershell,
  cimCommandLineQueryScript,
  cimParentPidScript,
  systemExe,
  parseListeningPids,
  listListeningPidsSync,
  listListeningPidsAsync,
  isPidAlive,
  terminatePid,
  processParentPidAsync,
  queryParentPidDetailedAsync,
  withParentPidRetry,
  describeExecFailure,
  interpretPidQuery,
  isRetryableExecFailure,
  PS_EXIT_NOT_FOUND,
  isReapableStale,
  listStaleServerPidsSync,
  type CimProcess,
  type ParentPidProbe,
} from './process';

export {
  pickFirstExisting,
  systemBinaryCandidates,
  pythonCandidates,
  resolveSystemBinary,
  resolvePython,
  resolvePowershell,
  resolveFfmpeg,
  bundledFfmpegCandidates,
  pythonBin,
  shellArg,
  toolPathEnv,
  resetBinaryCache,
  probeCapability,
  requireCapability,
  capabilitySnapshot,
  type Capability,
  type CapabilityId,
  type ExistsFn,
} from './binaries';
