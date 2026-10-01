/*
 * punct_server.c — 常驻标点服务（把 CT-Transformer 标点模型加载一次、反复复用）
 *
 * 为什么要它：sherpa-onnx-offline-punctuation CLI 每处理一段文本都要**重新启动进程 + 重新加载
 * 75MB 模型**（实测 ~135ms/段，其中推理仅 6ms）。实时字幕每段定稿都要补标点，这个开销无法接受。
 * 本程序直接调 sherpa-onnx 的 C API：模型加载一次常驻，之后每段只需一次推理（~3ms）。
 *
 * 调用契约（由 punct-server.ts 拉起，三者必须一致）：
 *   argv: punct-server <model.onnx> <libdir> [num_threads]
 *         libdir = 放 libsherpa-onnx-c-api.dylib 的目录（dlopen 用绝对路径，不依赖 @rpath 解析）
 *   stdout 行协议：
 *         启动就绪 → 一行 `READY`
 *         每条请求一行 → `OK <text>` / `ERR <message>`
 *   stdin 行协议：每行一条待标点文本，`\n` 在行内以 `\\n` 转义（`\\` → `\\`），故文本可含换行
 *   stderr：仅供排错（加载失败原因），调用方失败时回读
 *
 * 退出码：参数错误/加载失败 = 2（调用方据此回退到 CLI 方式，功能不中断）。
 */
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#if defined(_WIN32)
#error "punct-server: Windows is not supported"
#endif

/* sherpa-onnx C API 里用到的部分（避免引入头文件依赖，签名与 v1.13.8 一致） */
typedef struct {
  const char *ct_transformer;
  int num_threads;
  int debug;
  const char *provider;
} PunctModelConfig;

typedef void *(*CreateFn)(const PunctModelConfig *);
typedef const char *(*AddFn)(const void *handle, const char *text);
typedef void (*DestroyFn)(const void *handle);
typedef void (*FreeTextFn)(const char *text);

/** 行内转义解码：`\\n` `\\r` `\\t` `\\\\` → 真字符（原地展开，写指针不会超过读指针） */
static void unescape(char *s) {
  char *w = s;
  for (char *r = s; *r; ++r) {
    if (*r == '\\' && r[1]) {
      switch (*++r) {
        case 'n': *w++ = '\n'; break;
        case 'r': *w++ = '\r'; break;
        case 't': *w++ = '\t'; break;
        default: *w++ = *r; break;
      }
    } else {
      *w++ = *r;
    }
  }
  *w = '\0';
}

/** 输出转义：与上面的解码严格互逆（保证响应恒为单行） */
static void escape_out(const char *s) {
  for (const char *p = s; *p; ++p) {
    switch (*p) {
      case '\\': fputs("\\\\", stdout); break;
      case '\n': fputs("\\n", stdout); break;
      case '\r': fputs("\\r", stdout); break;
      default: fputc(*p, stdout); break;
    }
  }
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: punct-server <model.onnx> <libdir> [num_threads]\n");
    return 2;
  }
  const char *model = argv[1];
  const char *libdir = argv[2];
  int threads = argc > 3 ? atoi(argv[3]) : 2;
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
  CreateFn create = (CreateFn)dlsym(lib, "SherpaOnnxCreateOfflinePunctuation");
  AddFn add = (AddFn)dlsym(lib, "SherpaOfflinePunctuationAddPunct");
  DestroyFn destroy = (DestroyFn)dlsym(lib, "SherpaOnnxDestroyOfflinePunctuation");
  FreeTextFn free_text = (FreeTextFn)dlsym(lib, "SherpaOfflinePunctuationFreeText");
  if (!create || !add || !destroy) {
    fprintf(stderr, "sherpa-onnx punctuation symbols missing in %s\n", libpath);
    return 2;
  }

  PunctModelConfig cfg;
  memset(&cfg, 0, sizeof(cfg));
  cfg.ct_transformer = model;
  cfg.num_threads = threads;
  cfg.debug = 0;
  cfg.provider = "cpu";

  void *handle = create(&cfg);
  if (!handle) {
    fprintf(stderr, "failed to load punctuation model: %s\n", model);
    return 2;
  }

  printf("READY\n");
  fflush(stdout);

  char *line = NULL;
  size_t cap = 0;
  ssize_t n;
  while ((n = getline(&line, &cap, stdin)) != -1) {
    while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = '\0';
    if (n == 0) continue; /* 空行不是请求（调用方不会发） */
    unescape(line);
    const char *out = add(handle, line);
    if (out) {
      fputs("OK ", stdout);
      escape_out(out);
      fputc('\n', stdout);
      if (free_text) free_text(out); /* 释放 C 侧返回串，避免逐段泄漏 */
    } else {
      fputs("ERR punctuation failed\n", stdout);
    }
    fflush(stdout);
  }

  free(line);
  destroy(handle);
  return 0;
}