/* Actual portable QuickJS binding, with only its native write sink replaced. */
#define pocketjs_ui_core_set_prop capture_set_prop
#include "ui_qjs.c"
#undef pocketjs_ui_core_set_prop
#include <assert.h>
#include "quickjs-libc.h"
/* Probe native core is panic-abort; the C test never unwinds through Rust. */
void rust_eh_personality(void) {}
static double writes[16][3];
static unsigned count;
void capture_set_prop(pocketjs_ui_core_t *core, int32_t id, uint32_t prop, double value) {
  (void)core; assert(count < 16); writes[count][0]=id; writes[count][1]=prop; writes[count++][2]=value;
}
int main(void) {
  JSRuntime *rt=JS_NewRuntime(); assert(rt);
  JSContext *ctx=JS_NewContext(rt); assert(ctx);
  pocketjs_ui_qjs_t binding={0};
  JSValue global=JS_GetGlobalObject(ctx);
  set_function(ctx,global,"batch",js_set_prop_batch,1,&binding);
  JS_FreeValue(ctx,global);
  const char *source =
    "batch(); batch(new ArrayBuffer(0));"
    "const b=new ArrayBuffer(51),v=new DataView(b);"
    "[10,2,30.5,11,3,4294967295].forEach((n,i)=>v.setFloat64(i*8,n,true));"
    "batch(b);"
    "for(const bad of [undefined,{},new Uint8Array(24)]) {"
      "let thrown=false;try{batch(bad)}catch(e){thrown=e instanceof TypeError}"
      "if(!thrown)throw Error('type validation');"
    "}"
    "v.setFloat64(24,NaN,true);"
    "let failed=false;try{batch(b)}catch(e){failed=e instanceof RangeError}"
    "if(!failed)throw Error('NaN id validation');"
    "v.setFloat64(24,11,true);v.setFloat64(32,4294967296,true);"
    "failed=false;try{batch(b)}catch(e){failed=e instanceof RangeError}"
    "if(!failed)throw Error('prop range validation');";
  JSValue result=JS_Eval(ctx,source,strlen(source),"prop-batch-test",JS_EVAL_TYPE_GLOBAL);
  if(JS_IsException(result)) { js_std_dump_error(ctx); abort(); }
  JS_FreeValue(ctx,result);
  assert(count==4); /* 2 normal + valid prefix before each failed record */
  assert(writes[0][0]==10 && writes[0][1]==2 && writes[0][2]==30.5);
  assert(writes[1][0]==11 && writes[1][1]==3 && writes[1][2]==4294967295.0);
  assert(writes[2][2]==30.5 && writes[3][2]==30.5);
  JS_FreeContext(ctx);JS_FreeRuntime(rt);
  puts("QuickJS property batch regressions passed");
}
