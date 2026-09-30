// Minimal embedding glue for SpiderMonkey's native Promise/await job hooks.
// Context data is captured when reactions are registered, not when resolved.
#pragma once
#include "extension-api.h"
#include "js/Promise.h"
#include "js/CallAndConstruct.h"
#include "jsfriendapi.h"
#include <deque>
#include <memory>

namespace hibana::async_context {
struct Job {
  JS::PersistentRootedObject callback;
  JS::PersistentRootedObject context;
  Job(JSContext *cx, JS::HandleObject fn, JS::HandleObject data)
      : callback(cx, fn), context(cx, data) {}
};

class Queue final : public JS::JobQueue {
  using Jobs = std::deque<std::unique_ptr<Job>>;
  Jobs jobs_;
  bool running_ = false;
public:
  JS::PersistentRootedObject current;
  explicit Queue(JSContext *cx) : current(cx) {}
  bool getHostDefinedData(JSContext *, JS::MutableHandleObject data) const override {
    data.set(current);
    return true;
  }
  bool enqueuePromiseJob(JSContext *cx, JS::HandleObject, JS::HandleObject job,
                         JS::HandleObject, JS::HandleObject data) override {
    jobs_.push_back(std::make_unique<Job>(cx, job, data));
    return true;
  }
  bool empty() const override { return jobs_.empty(); }
  bool isDrainingStopped() const override { return false; }
  void runJobs(JSContext *cx) override {
    if (running_) return;
    running_ = true;
    while (!jobs_.empty()) {
      auto job = std::move(jobs_.front());
      jobs_.pop_front();
      JS::RootedObject previous(cx, current);
      current = job->context;
      JS::RootedObject callback(cx, job->callback);
      JSAutoRealm realm(cx, callback);
      JS::RootedValue result(cx);
      bool ok = JS::Call(cx, JS::UndefinedHandleValue, callback,
                         JS::HandleValueArray::empty(), &result);
      current = previous;
      if (!ok) break;
    }
    running_ = false;
  }
private:
  class Saved final : public SavedJobQueue {
    Queue &queue_;
    Jobs jobs_;
    bool running_;
  public:
    explicit Saved(Queue &queue)
        : queue_(queue), jobs_(std::move(queue.jobs_)), running_(queue.running_) {
      queue_.running_ = false;
    }
    ~Saved() override {
      MOZ_ASSERT(queue_.jobs_.empty());
      queue_.jobs_ = std::move(jobs_);
      queue_.running_ = running_;
    }
  };
  js::UniquePtr<SavedJobQueue> saveJobQueue(JSContext *cx) override {
    auto saved = js::UniquePtr<SavedJobQueue>(new (std::nothrow) Saved(*this));
    if (!saved) JS_ReportOutOfMemory(cx);
    return saved;
  }
};

inline Queue *queue = nullptr;
inline void run_jobs(JSContext *cx) {
  if (queue) queue->runJobs(cx);
  else js::RunJobs(cx);
}

inline bool get(JSContext *cx, unsigned argc, JS::Value *vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  args.rval().setObjectOrNull(queue->current);
  return true;
}
inline bool set(JSContext *cx, unsigned argc, JS::Value *vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  if (!args.requireAtLeast(cx, "async context", 1)) return false;
  if (!args[0].isObjectOrNull()) {
    JS_ReportErrorASCII(cx, "Async context must be an object or null");
    return false;
  }
  queue->current = args[0].toObjectOrNull();
  args.rval().setUndefined();
  return true;
}
bool install(api::Engine *engine);
} // namespace hibana::async_context
