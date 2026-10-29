/** Per-read lifetime; no browser-global polyfill or shared caller cancellation. */
export function dataAbortScope(parent:AbortSignal|undefined,milliseconds:number) {
  const controller=new AbortController();let timedOut=false;
  const abort=()=>controller.abort(parent?.reason??new DOMException("Read cancelled","AbortError"));
  const timer=setTimeout(()=>{
    timedOut=true;controller.abort(new DOMException("Read deadline exceeded","TimeoutError"));
  },milliseconds);
  if(parent?.aborted)abort();else parent?.addEventListener("abort",abort,{once:true});
  return {signal:controller.signal,timedOut:()=>timedOut,
    dispose(){clearTimeout(timer);parent?.removeEventListener("abort",abort);}};
}
