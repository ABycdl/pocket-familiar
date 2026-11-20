import {newId} from './wire.js';

// Follow embed.js reply qualification. Only qualified attempt IDs reach storage.
export function watchGenerations(getTavern,onGeneration,onError){
 const tavern=getTavern();
 if(!tavern?.eventSource||!tavern.eventTypes)return false;
  const {eventSource,eventTypes}=tavern;
  const replyTypes=new Set(['normal','group_chat','regenerate','swipe','continue','append','appendFinal']);
  const continuationTypes=new Set(['continue','append','appendFinal']);
  const generationPaths=new Set([
   '/api/backends/chat-completions/generate','/api/backends/text-completions/generate',
   '/api/backends/kobold/generate','/api/novelai/generate'
  ]);
  const truncatedReasons=new Set(['length','max_tokens','max_output_tokens','max_length','token_limit','model_length','content_filter','safety','recitation','error','cancelled','canceled','abort','aborted','interrupted','time_limit']);
  let active=null;
  function responseStatus(data){
   const choice=Array.isArray(data?.choices)?data.choices.find(choice=>choice&&(choice.index==null||choice.index===0)):null;
   const reason=choice?.finish_reason??data?.candidates?.[0]?.finishReason??data?.delta?.stop_reason??data?.response?.incomplete_details?.reason??data?.finish_reason??data?.stop_reason??data?.done_reason??data?.stop_type;
   if(data?.error||data?.stopped_limit||data?.truncated||data?.results?.[0]?.stopped_limit||data?.results?.[0]?.truncated||data?.type==='response.incomplete'||data?.type==='response.failed'||truncatedReasons.has(String(reason).toLowerCase()))return 'truncated';
   if(reason||data?.done===true||['message_stop','response.completed','stream_end'].includes(data?.type))return 'finished';
   return null;
  }
  async function responseWasTruncated(response){
   if(!response.ok)return true;
   const contentType=response.headers.get('content-type')??'';
   if(contentType.includes('json'))return responseStatus(await response.json())==='truncated';
   if(!contentType.includes('text/event-stream')||!response.body)return false;
   const reader=response.body.getReader(),decoder=new TextDecoder();
   let pending='',expectsFinish=false,finished=false;
   try{
    for(;;){
     const {value,done}=await reader.read();
     pending+=decoder.decode(value,{stream:!done});
     const lines=pending.split('\n');
     pending=done?'':lines.pop();
     for(const line of lines){
      if(!line.startsWith('data:'))continue;
      const payload=line.slice(5).trim();
      if(payload==='[DONE]')return false;
      let data;
      try{data=JSON.parse(payload);}catch{continue;}
      const status=responseStatus(data);
      if(status==='truncated')return true;
      if(status==='finished')finished=true;
      if(Array.isArray(data?.choices)||Array.isArray(data?.candidates)||data?.type==='message_start')expectsFinish=true;
     }
     if(done)return expectsFinish&&!finished;
    }
   }finally{void reader.cancel().catch(()=>{});}
  }
  // The Tavern message event omits the provider's finish reason. Read only completion status on a parallel response branch.
  const tavernFetch=globalThis.fetch;
  globalThis.fetch=function(input,init){
   const attempt=active;
   const response=tavernFetch.call(this,input,init);
   if(attempt&&!attempt.completed&&!attempt.transport&&(init?.method??input?.method)==='POST'){
    try{
     const url=new URL(input?.url??input,location.href);
     if(url.origin===location.origin&&generationPaths.has(url.pathname)){
      attempt.transport=response.then(result=>responseWasTruncated(result.clone())).catch(()=>true);
     }
    }catch{}
   }
   return response;
  };
  function currentAttempt(context){
   return active&&!active.completed&&context?.chat===active.chat&&context.getCurrentChatId?.()===active.chatId?active:null;
  }
  function visibleStreamText(context,text){
   if(typeof text!=='string')return '';
   const parsed=context.parseReasoningFromString?.(text);
   const reasoning=context.powerUserSettings?.reasoning;
   if(reasoning?.prefix&&reasoning?.suffix&&text.trimStart().startsWith(reasoning.prefix)&&!text.trimStart().slice(reasoning.prefix.length).includes(reasoning.suffix))return '';
   return parsed?.content??text;
  }
  async function replyTokenCount(context,text){
   if(context.mainApi!=='openai'||!context.getTokenizerModel||!context.getRequestHeaders)return await context.getTokenCountAsync(text);
   // Subtract the empty-message framing added by the selected chat tokenizer.
   const endpoint='/api/tokenizers/openai/count?model='+encodeURIComponent(context.getTokenizerModel());
   const count=async content=>{
    const response=await tavernFetch.call(globalThis,endpoint,{method:'POST',headers:context.getRequestHeaders(),body:JSON.stringify([{content}])});
    if(!response.ok)throw new Error('Tavern tokenizer unavailable');
    return (await response.json()).token_count;
   };
   const [total,framing]=await Promise.all([count(text),count('')]);
   return total-framing;
  }
  function recordReply(attempt,context,reply,interrupted){
   attempt.completed=true;
   const text=typeof reply==='string'?reply.trim():'';
   if(!text||/^[\s\u200B-\u200D\uFEFF]+$/.test(text))return;
   void (async()=>{
    if((interrupted||await attempt.transport)&&!(await replyTokenCount(context,text)>500))return;
    onGeneration(attempt.key);
   })().catch(onError);
  }
  eventSource.on(eventTypes.GENERATION_AFTER_COMMANDS,(type,options,dryRun)=>{
   if(dryRun||!replyTypes.has(type))return;
   const context=getTavern();
   if(!Array.isArray(context?.chat))return;
   const previous=context.chat.at(-1);
   active={
    type,chat:context.chat,chatId:context.getCurrentChatId?.(),
    previousStream:context.streamingProcessor,started:Date.now(),
    prefix:continuationTypes.has(type)&&typeof previous?.mes==='string'?previous.mes:'',
    key:newId()
   };
  });
  function recordInterruptedStream(){
   const context=getTavern(),attempt=currentAttempt(context),stream=context?.streamingProcessor;
   if(!attempt||!stream||stream===attempt.previousStream||stream.type!==attempt.type||!(stream.isStopped||stream.abortController?.signal.aborted))return;
   recordReply(attempt,context,visibleStreamText(context,stream.result),true);
  }
  eventSource.on(eventTypes.GENERATION_STOPPED,recordInterruptedStream);
  eventSource.on(eventTypes.GENERATION_ENDED,recordInterruptedStream);
  eventSource.on(eventTypes.MESSAGE_RECEIVED,(index,type)=>{
   if(!replyTypes.has(type)||!Number.isSafeInteger(index)||index<0)return;
   const context=getTavern(),attempt=currentAttempt(context);
   if(!attempt)return;
   const message=context.chat[index];
   const start=+new Date(message?.gen_started),finish=+new Date(message?.gen_finished);
   if(message?.is_user!==false||message.is_system||!(start>0&&finish>=start&&finish>=attempt.started))return;
   const stream=context.streamingProcessor;
   const streamed=stream&&stream!==attempt.previousStream&&stream.messageId===index&&+new Date(stream.timeStarted)===start;
   if(streamed&&(stream.isStopped||stream.abortController?.signal.aborted||!stream.isFinished)){
    recordInterruptedStream();
    return;
   }
   let text=message.mes;
   if(streamed&&!stream.result?.trim())text='';
   if(attempt.prefix&&typeof text==='string'){
    if(text.startsWith(attempt.prefix))text=text.slice(attempt.prefix.length);
    else if(text.startsWith(attempt.prefix.trimEnd()))text=text.slice(attempt.prefix.trimEnd().length);
    else text=streamed?visibleStreamText(context,stream.result):'';
   }
   recordReply(attempt,context,text,false);
  });
 return true;
}
