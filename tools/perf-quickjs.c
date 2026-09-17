// Minimal, standalone runner for perf-audit.ts's browser/IIFE bundle.
// Link to host/macos/target/release/build/rquickjs-sys-*/out/libquickjs.a.
// Supplies console.log and a monotonic performance.now; no UI/IO bridge.
#include "quickjs.h"
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static JSValue perf_now(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self; (void)argc; (void)argv;
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return JS_NewFloat64(ctx, now.tv_sec * 1000.0 + now.tv_nsec / 1000000.0);
}

static JSValue print_line(JSContext *ctx, JSValueConst self, int argc, JSValueConst *argv) {
    (void)self;
    for (int i = 0; i < argc; i++) {
        const char *text = JS_ToCString(ctx, argv[i]);
        if (!text) return JS_EXCEPTION;
        if (i) putchar(' ');
        fputs(text, stdout);
        JS_FreeCString(ctx, text);
    }
    putchar('\n');
    fflush(stdout);
    return JS_UNDEFINED;
}

int main(int argc, char **argv) {
    if (argc != 2) { fprintf(stderr, "usage: %s benchmark.js\n", argv[0]); return 2; }
    FILE *file = fopen(argv[1], "rb");
    if (!file) { perror(argv[1]); return 2; }
    if (fseek(file, 0, SEEK_END) != 0) { fclose(file); return 2; }
    long size = ftell(file);
    if (size < 0 || fseek(file, 0, SEEK_SET) != 0) { fclose(file); return 2; }
    char *source = malloc((size_t)size + 1);
    if (!source) { fclose(file); return 2; }
    size_t read = fread(source, 1, (size_t)size, file);
    fclose(file);
    if (read != (size_t)size) { free(source); return 2; }
    source[size] = '\0';

    JSRuntime *rt = JS_NewRuntime();
    JSContext *ctx = rt ? JS_NewContext(rt) : NULL;
    if (!ctx) { free(source); if (rt) JS_FreeRuntime(rt); return 2; }
    JSValue global = JS_GetGlobalObject(ctx);
    JSValue console = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, console, "log", JS_NewCFunction(ctx, print_line, "log", 1));
    JS_SetPropertyStr(ctx, global, "console", console);
    JSValue performance = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, performance, "now", JS_NewCFunction(ctx, perf_now, "now", 0));
    JS_SetPropertyStr(ctx, global, "performance", performance);
    JS_FreeValue(ctx, global);

    JSValue result = JS_Eval(ctx, source, (size_t)size, argv[1], JS_EVAL_TYPE_GLOBAL);
    free(source);
    int failed = JS_IsException(result);
    if (failed) {
        JSValue err = JS_GetException(ctx);
        const char *text = JS_ToCString(ctx, err);
        fprintf(stderr, "%s\n", text ? text : "QuickJS exception");
        if (text) JS_FreeCString(ctx, text);
        JSValue stack = JS_GetPropertyStr(ctx, err, "stack");
        text = JS_ToCString(ctx, stack);
        if (text) { fprintf(stderr, "%s\n", text); JS_FreeCString(ctx, text); }
        JS_FreeValue(ctx, stack);
        JS_FreeValue(ctx, err);
    }
    JS_FreeValue(ctx, result);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    return failed ? 1 : 0;
}
