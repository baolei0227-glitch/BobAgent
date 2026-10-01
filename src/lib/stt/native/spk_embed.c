/*
 * spk_embed.c — 声纹向量提取（批量 CLI）
 *
 * 为什么要自己写：随 shared 包发布的 `sherpa-onnx-offline-speaker-identification` **不存在**
 * （macOS 包只有 `sherpa-onnx-microphone-offline-speaker-identification`，只能从麦克风实时识别、
 * 不读文件），而「跨录音认出同一个人」必须要拿到声纹向量。故直接调 sherpa-onnx 的 C API：
 * 加载 3dspeaker embedding 模型，把每个 wav 转成一个定长向量吐出来。
 * 模型就是 diarization 已在用的那个（同一目录、无需额外下载），故两边口径天然一致。
 *
 * 为什么是**批量一次性 CLI** 而不是常驻服务：调用方（导入录音）天然是「一次录音 → 若干个语音段」，
 * 一批一起算正好只加载一次模型（39MB），批内每段只需一次推理；没有请求/响应配对与空闲回收的必要，
 * 比常驻服务简单得多。diarize 也是同样的「整段跑一次」思路。
 *
 * 调用契约（由 lib/stt/speaker-embed.ts 拉起，两者必须一致）：
 *   argv: spk-embed <model.onnx> <libdir> <num_threads> <wav1> [wav2 ...]
 *         libdir = 放 libsherpa-onnx-c-api.dylib 的目录（dlopen 用绝对路径，不依赖 @rpath 解析）
 *   stdout：**每个输入 wav 一行，顺序与 argv 一致**：
 *         `OK <dim> <f0> <f1> ...`（%.7g，够余弦计算且不至于把行撑爆）
 *         `ERR <message>`（该文件读不了 / 算不出，调用方按序号跳过这一段）
 *   stderr：仅供排错（引擎日志、加载失败原因），调用方失败时回读
 *
 * 退出码：参数错误 / dlopen 失败 / 符号缺失 / 模型加载失败 = 2（调用方据此判定「不可用」并降级）；
 *         单个文件失败不退出，只影响该行输出。
 *
 * 实测（v1.13.8 + 3dspeaker ERes2Net，512 维）：同一人两段 cosine≈0.73，不同人≈0.11，
 * 区分度极大。注意 `IsReady` 对离线模型恒返回 0（喂完整段后即可直接 ComputeEmbedding），
 * 所以**不能**用 IsReady 当就绪判据。
 */
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#error "spk-embed: Windows is not supported"
#endif

/* sherpa-onnx C API 里用到的部分（不引头文件，结构体布局与 v1.13.8 一致） */
typedef struct {
  const float *samples;
  int sample_rate;
  int num_samples;
} Wave;

typedef struct {
  const char *model;
  int num_threads;
  int debug;
  const char *provider;
} ExtractorConfig;

typedef void *Extractor;
typedef void *OnlineStream;

int main(int argc, char **argv) {
  if (argc < 5) {
    fprintf(stderr, "usage: spk-embed <model.onnx> <libdir> <num_threads> <wav> [wav ...]\n");
    return 2;
  }
  const char *model = argv[1];
  const char *libdir = argv[2];
  int threads = atoi(argv[3]);
  if (threads <= 0) threads = 2;

  char libpath[4096];
#if defined(__APPLE__)
  const char *libname = "libsherpa-onnx-c-api.dylib";
#else
  const char *libname = "libsherpa-onnx-c-api.so";
#endif
  snprintf(libpath, sizeof(libpath), "%s/%s", libdir, libname);

  void *lib = dlopen(libpath, RTLD_NOW | RTLD_GLOBAL);
  if (!lib) {
    fprintf(stderr, "dlopen(%s) failed: %s\n", libpath, dlerror());
    return 2;
  }
  Wave *(*read_wave)(const char *) = (Wave * (*)(const char *))dlsym(lib, "SherpaOnnxReadWave");
  void (*free_wave)(Wave *) = (void (*)(Wave *))dlsym(lib, "SherpaOnnxFreeWave");
  Extractor (*create)(const ExtractorConfig *) =
      (Extractor(*)(const ExtractorConfig *))dlsym(lib, "SherpaOnnxCreateSpeakerEmbeddingExtractor");
  void (*destroy)(Extractor) = (void (*)(Extractor))dlsym(lib, "SherpaOnnxDestroySpeakerEmbeddingExtractor");
  int (*dim_fn)(Extractor) = (int (*)(Extractor))dlsym(lib, "SherpaOnnxSpeakerEmbeddingExtractorDim");
  OnlineStream (*create_stream)(Extractor) =
      (OnlineStream(*)(Extractor))dlsym(lib, "SherpaOnnxSpeakerEmbeddingExtractorCreateStream");
  const float *(*compute)(Extractor, OnlineStream) =
      (const float *(*)(Extractor, OnlineStream))dlsym(lib, "SherpaOnnxSpeakerEmbeddingExtractorComputeEmbedding");
  void (*destroy_embedding)(const float *) =
      (void (*)(const float *))dlsym(lib, "SherpaOnnxSpeakerEmbeddingExtractorDestroyEmbedding");
  void (*accept)(OnlineStream, int, const float *, int) =
      (void (*)(OnlineStream, int, const float *, int))dlsym(lib, "SherpaOnnxOnlineStreamAcceptWaveform");
  void (*destroy_stream)(OnlineStream) = (void (*)(OnlineStream))dlsym(lib, "SherpaOnnxDestroyOnlineStream");
  if (!read_wave || !create || !dim_fn || !create_stream || !compute || !accept) {
    fprintf(stderr, "sherpa-onnx speaker embedding symbols missing in %s\n", libpath);
    return 2;
  }

  ExtractorConfig cfg;
  memset(&cfg, 0, sizeof(cfg));
  cfg.model = model;
  cfg.num_threads = threads;
  cfg.debug = 0;
  cfg.provider = "cpu";

  Extractor ex = create(&cfg);
  if (!ex) {
    fprintf(stderr, "failed to load speaker embedding model: %s\n", model);
    return 2;
  }
  int dim = dim_fn(ex);

  // 逐文件：读 wav → 建流 → 喂整段 → 算向量 → 一行输出。单个文件失败只影响它那一行
  for (int i = 4; i < argc; i++) {
    Wave *w = read_wave(argv[i]);
    if (!w) {
      fprintf(stdout, "ERR cannot read wave\n");
      fflush(stdout);
      continue;
    }
    OnlineStream st = create_stream(ex);
    accept(st, w->sample_rate, w->samples, w->num_samples);
    const float *v = compute(ex, st);
    if (!v) {
      fprintf(stdout, "ERR cannot compute embedding\n");
      fflush(stdout);
    } else {
      fputs("OK ", stdout);
      fprintf(stdout, "%d", dim);
      for (int k = 0; k < dim; k++) fprintf(stdout, " %.7g", v[k]);
      fputc('\n', stdout);
      fflush(stdout);
      if (destroy_embedding) destroy_embedding(v);
    }
    if (destroy_stream) destroy_stream(st);
    if (free_wave) free_wave(w);
  }

  destroy(ex);
  return 0;
}