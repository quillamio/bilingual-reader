/** Bounded in-memory diagnostic report. No free-form strings are retained. */
const providers=new Set("google googleapi bing youdao huoshanweb tencenttransmart mymemory deeplx cnki iciba baidu baidufield caiyun deeplfree deeplpro microsoft glm47flash openai customgpt1 customgpt2 customgpt3 azuregpt gemini claude qwenmt niutranspro openl aliyun tencent huoshan xftrans youdaozhiyun youdaozhiyunllm libretranslate mtranserver deeplcustom nllbserve nllbapi siliconflow openrouter googlecloud pdftranslate ollama pdfjs docling mineru mistral llamaparse doc2x mathpix belindoc local babeldoc pdf2zh-next localpdf".split(" "));
const stages=new Set(["request","parse","export","fallback","layout"]);
const outcomes=new Set(["start","success","failure","cancelled","cooldown"]);
type Entry={time:string;provider:string;stage:string;outcome:string;status?:number;count?:number};
const events:Entry[]=[];
export function recordDiagnostic(provider:string,stage:string,outcome:string,status?:number,count?:number):void {
  const event:Entry={time:new Date().toISOString(),provider:providers.has(provider)?provider:"other",stage:stages.has(stage)?stage:"other",outcome:outcomes.has(outcome)?outcome:"other"};
  if(typeof status==="number"&&Number.isInteger(status)&&status>=400&&status<=599)event.status=status;
  if(typeof count==="number"&&Number.isInteger(count)&&count>=0&&count<=1000000)event.count=count;
  events.push(event);if(events.length>300)events.shift();
}
export function getDiagnosticReport():string{return JSON.stringify({schema:1,events},null,2);}
export function clearDiagnostics():void{events.length=0;}
