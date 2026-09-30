#include "async-context.h"
namespace hibana::async_context {
bool install(api::Engine *engine) {
  auto cx = engine->cx();
  // The embedding owns one context for the lifetime of a Wasm instance.
  queue = new Queue(cx);
  JS::SetJobQueue(cx, queue);
  JS::RootedObject hooks(cx, JS_NewPlainObject(cx));
  if (!hooks || !JS_DefineFunction(cx, hooks, "get", get, 0, 0) ||
      !JS_DefineFunction(cx, hooks, "set", set, 1, 0)) return false;
  return JS_DefineProperty(cx, engine->global(), "__hibanaAsyncContext", hooks, 0);
}
}
