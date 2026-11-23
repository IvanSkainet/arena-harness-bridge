const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

for(const scenario of ['selected','summary then reply','prose beside summary','confirmation lost','failed before choice','foreign choice','unsupported','display only','display only Summary','display only removed','display only same row prose','closed handshake','dismissed handshake','verification before selection confirmation']) {
  test('site question '+scenario,async()=>{
    const chat='https://arena.ai/agent/native', events=[], choices=[], polls=[], fields={};
    const rows=[{role:'user',text:'past'},{role:'assistant',text:'done',complete:true}];
    const card={id:'chat-message-native',question:'Which color?',options:['Amber','Indigo']};
    const item={role:'assistant',nativeMessage:true,siteId:card.id,prose:'Choose.',text:'Which color? Amber Indigo',
      nativeQuestion:{...card,status:'active'},complete:false};
    let listener,tick,notify,now=1000,offered=false,deliver=false,verification=false;
    const sent=card=>JSON.parse(JSON.stringify(card));
    const ctx=vm.createContext({crypto,URL,location:{href:chat},Date:class extends Date{static now(){return now;}},
      document:{documentElement:{}},addEventListener(){},setInterval:fn=>tick=fn,
      MutationObserver:class{constructor(fn){notify=fn;}observe(){}},
      chrome:{runtime:{id:'test',onMessage:{addListener:fn=>listener=fn},sendMessage:async msg=>{
        if(msg.type==='event')events.push(sent(msg.event));
        const reply={ok:true,supportsNativeQuestions:scenario!=='unsupported'};
        if(msg.event?.nativeQuestion)Object.assign(reply,{nativeQuestionHandled:scenario.startsWith('display only')?'display-only':'interactive',
          nativeQuestionId:card.id,replyTo:'request-job'});
        if(msg.type==='poll'){
          polls.push(msg);
          if(msg.nativeQuestionClosed && scenario.endsWith('handshake'))reply.nativeQuestionClosed=msg.nativeQuestionId;
          if(msg.ready && !offered){offered=true;reply.job={id:'request-job',text:'Ask the user'};}
          else if(msg.nativeQuestionId===card.id && deliver){
            deliver=false;reply.job={id:'answer-job',nativeAnswer:{...card,answer:scenario==='foreign choice'?'Not listed':'Indigo'}};
          }
        }
        return reply;
      }}},
      ArenaPage:class{
        state(){return {field:fields,ready:!verification&&(rows.at(-1)!==item || item.complete),idle:!verification,generating:false,value:'',verification};}
        rows(){return rows.map(r=>({...r}));}
        async submit(job,draft,guard,click){assert.ok(guard());click();rows.push({role:'user',text:job.text,siteId:'chat-message-'+job.id,lastLine:job.text.split('\n').at(-1)});}
        selectNativeAnswer(answer){
          choices.push(answer.answer);
          if (scenario==='verification before selection confirmation') { verification=true; rows.pop(); return; }
          const summary=['summary then reply','prose beside summary','confirmation lost'].includes(scenario);
          item.nativeQuestion=summary
            ? {id:card.id,question:card.question,options:[],status:'answered',summary:true,selected:answer.answer}
            : {...card,status:'answered',selected:answer.answer};
          if(summary) {item.prose='';item.text='Summary: Indigo';item.complete=true;}
          notify();
        }
      }});
    for(const file of ['core.js','content.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
    const ctrl=msg=>new Promise(resolve=>listener(msg,{id:'test'},resolve));
    const prepared=await ctrl({type:'prepare',chat});
    await ctrl({type:'attach',chat,binding:'b1',pageKey:prepared.pageKey});
    await tick();await tick();rows.push(item);notify();now+=1900;await tick();await tick();
    if(scenario==='unsupported'){
      assert.equal(events.some(e=>e.nativeQuestion||e.toolFrame),false);
      assert.ok(events.some(e=>e.kind==='assistant' && e.text.includes('Which color?')));
      return;
    }
    const asks=events.filter(e=>e.nativeQuestion);
    assert.deepEqual(asks.map(e=>[e.nativeQuestion,e.replyTo]),[[card,'request-job']]);
    if(scenario.startsWith('display only') || scenario.endsWith('handshake')){
      if(scenario.startsWith('display only'))assert.ok(!polls.some(p=>p.nativeQuestionId));
      item.nativeQuestion={...card,status:'failed'};item.text='Question failed';item.complete=true;
      if(scenario==='display only Summary') {item.prose='';item.text='Summary';item.nativeQuestion={id:card.id,
        question:card.question,status:'answered',options:[],summary:true,selected:'Indigo'};}
      if(scenario==='display only removed')rows.pop();
      if(scenario==='display only same row prose'){delete item.nativeQuestion;item.prose=item.text='Resolved.';}
      if(scenario==='dismissed handshake') {item.prose='';item.text='Questions dismissed';item.nativeQuestion={id:card.id,status:'dismissed',options:[]};}
      notify();now+=2000;await tick();await tick();now+=1000;await tick();
      if(scenario.endsWith('handshake'))assert.ok(polls.some(p=>p.nativeQuestionClosed && p.nativeQuestionId===card.id));
      assert.equal(polls.at(-1).ready,true,'idle composer can receive another ordinary turn after a spent widget');
      if(scenario==='display only Summary'||scenario==='dismissed handshake'){
        rows.push({role:'assistant',siteId:'late',nativeMessage:true,text:'late widget reply',complete:true,toolFrame:true});
        notify();now+=1000;await tick();await tick();
        assert.equal(polls.at(-1).ready,true,'late passive followup stays contextual and cannot issue commands');
      }
      assert.equal(events.filter(e=>e.kind==='assistant').length,1);assert.deepEqual(choices,[]);
      return;
    }
    assert.ok(polls.some(p=>p.nativeQuestionId===card.id && !p.ready));
    assert.deepEqual(choices,[]);
    if(scenario==='failed before choice')item.nativeQuestion={...card,status:'failed'};
    deliver=true;await tick();await tick();
    if (scenario==='verification before selection confirmation') {
      now+=60000;await tick();
      verification=false;notify();await tick();
      now+=4000;await tick();
      assert.equal(events.some(e=>['uncertain','blocked'].includes(e.kind)),false);
      rows.push(item);
      item.nativeQuestion={...card,status:'answered',selected:'Indigo'};
      item.prose=item.text='Received Indigo.';item.complete=true;
      notify();now+=1800;await tick();await tick();
      assert.deepEqual(choices,['Indigo']);
      assert.deepEqual(events.filter(e=>e.kind==='sent').map(e=>e.job),['request-job','answer-job']);
      assert.deepEqual(events.filter(e=>e.kind==='assistant'&&!e.nativeQuestion).map(e=>e.text),['Received Indigo.']);
      return;
    }
    if(!['selected','summary then reply','prose beside summary','confirmation lost'].includes(scenario)){
      assert.deepEqual(choices,[]);
      assert.deepEqual(events.filter(e=>e.kind==='blocked').map(e=>e.job),['answer-job']);
      return;
    }
    assert.deepEqual(choices,['Indigo']);
    if(scenario==='summary then reply'){
      now+=2000;notify();await tick();
      assert.equal(events.filter(e=>e.kind==='assistant'&&!e.nativeQuestion).length,0,'summary alone acknowledges the choice, not the following reply');
      rows.push({role:'assistant',siteId:'chat-message-result',nativeMessage:true,text:'Received Indigo.',complete:true});
    } else if(scenario==='confirmation lost'){
      item.nativeQuestion=null;item.prose='';item.text='';now+=125000;
      notify();await tick();await tick();
      assert.deepEqual(events.filter(e=>e.kind==='blocked').map(e=>e.job),['answer-job']);return;
    } else {item.prose='Received Indigo.';item.text='Received Indigo.';item.complete=true;}
    notify();now+=1800;await tick();await tick();
    assert.deepEqual(events.filter(e=>e.kind==='sent').map(e=>e.job),['request-job','answer-job']);
    assert.deepEqual(events.filter(e=>e.kind==='assistant'&&!e.nativeQuestion).map(e=>e.text),['Received Indigo.']);
    assert.equal(events.filter(e=>e.nativeQuestion).length,1);
  });
}

for (const outcome of ['select and skip both panels','changed preview order','lazy previews','text question before images','text question after images']) {
  test('image galleries '+outcome,async()=>{
    const chat='https://arena.ai/agent/image-sequence', field={}, events=[], clicked=[];
    const rows=[{role:'user',text:'old'},{role:'assistant',text:'old answer',complete:true}];
    const cards=[0,1].map(index=>({id:'chat-message-gallery/image-choice/'+(index+1),question:'Which image do you prefer?',
      status:'active',options:['Image 1','Image 2','Skip'],sources:['/a'+index,'/b'+index],images:[{},{}]}));
    const row={role:'assistant',nativeMessage:true,siteId:'chat-message-gallery',text:'Choose an image.',prose:'Choose an image.',
      complete:false,imageChoices:[...cards]};
    const textCard={id:'chat-message-gallery',question:'Confirm?',options:['Yes'],status:'active'};
    if(outcome==='lazy previews') cards[0].status='loading';
    if(outcome==='text question before images') row.nativeQuestion=textCard;
    let listener, tick, notify, now=1000, offered=false, answer;
    const ctx=vm.createContext({crypto,URL,location:{href:chat},Date:class extends Date{static now(){return now;}},
      document:{documentElement:{}},addEventListener(){},setInterval:fn=>tick=fn,
      MutationObserver:class{constructor(fn){notify=fn;}observe(){}},
      ArenaGeneratedImages:{async encode(card){return card.sources.map(data=>({mediaType:'image/png',data}));},
        activate(card){assert.equal(card.id,cards[0].id);cards[0].status='active';}},
      chrome:{runtime:{id:'test',onMessage:{addListener:fn=>listener=fn},sendMessage:async message=>{
        const result={ok:true,supportsNativeQuestions:true,supportsImageChoices:true};
        if(message.type==='event'){
          const event=JSON.parse(JSON.stringify(message.event));events.push(event);
          if(event.nativeQuestion) Object.assign(result,{nativeQuestionHandled:'interactive',
            nativeQuestionId:event.nativeQuestion.id,replyTo:event.replyTo});
        }
        if(message.type==='poll'){
          if(message.ready && !offered){offered=true;result.job={id:'gallery-request',text:'Generate comparison'};}
          else if(answer && message.nativeQuestionId===answer.nativeAnswer.id){result.job=answer;answer=null;}
        }
        return result;
      }}},
      ArenaPage:class{
        state(){return {field,ready:rows.length<4 || rows.at(-1).complete,idle:true,generating:false,value:''};}
        rows(){return rows.map(value=>({...value}));}
        async submit(job,draft,guard,click){assert.ok(guard());click();rows.push({role:'user',text:job.text,
          siteId:'chat-message-user',lastLine:job.text.split('\n').at(-1)});}
        selectImageChoice(choice, sources) {
          const index=cards.findIndex(card=>card.id===choice.id);
          assert.equal(JSON.stringify(sources),JSON.stringify(cards[index].sources));
          clicked.push([index,choice.answer]);
          row.imageChoices[index]=choice.answer==='Skip' ? {id:choice.id,status:'skipped',sources}
            : {id:choice.id,status:'selected',sources:[sources[1]]};
          if(index===1 && outcome==='text question after images') row.nativeQuestion=textCard;
          notify();
        }
        selectNativeAnswer(choice) {
          assert.equal(choice.id,textCard.id);
          clicked.push(['text',choice.answer]);
          row.nativeQuestion={...textCard,status:'answered',selected:choice.answer};
          notify();
        }
      }});
    for (const file of ['core.js','content.js']) vm.runInContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),ctx);
    const send=msg=>new Promise(resolve=>listener(msg,{id:'test'},resolve));
    const prepared=await send({type:'prepare',chat});
    await send({type:'attach',chat,binding:'b1',pageKey:prepared.pageKey});
    await tick();await tick();rows.push(row);notify();
    const settle=async()=>{for(let index=0;index<4;index++){now+=1100;await tick();}};
    await settle();
    const questions=()=>events.filter(event=>event.nativeQuestion);
    const answerFor=(card,id,pick)=>({id,nativeAnswer:{id:card.id,question:card.question,options:card.options,answer:pick}});
    const before=outcome==='text question before images', after=outcome==='text question after images';
    if(before){
      assert.equal(questions().at(-1)?.nativeQuestion.id,textCard.id);
      answer=answerFor(textCard,'gallery-answer-before','Yes');await settle();
    }
    const imageEvents=()=>questions().filter(event=>event.choicePreviews)
      .map(event=>[event.nativeQuestion.id,event.replyTo,event.choicePreviews.map(img=>img.data)]);
    const first=[cards[0].id,before?'gallery-answer-before':'gallery-request',cards[0].sources];
    assert.deepEqual(imageEvents(),[first]);
    answer=answerFor(cards[0],'gallery-answer-1','Image 2');
    if(outcome==='changed preview order'){
      row.imageChoices[0]={...cards[0],sources:[...cards[0].sources].reverse()};notify();
      await settle();
      assert.deepEqual(clicked,[]);
      assert.equal(events.filter(event=>event.kind==='blocked'&&event.job==='gallery-answer-1').length,1);
      return;
    }
    await settle();
    assert.deepEqual(imageEvents(),[first,[cards[1].id,'gallery-answer-1',cards[1].sources]]);
    answer=answerFor(cards[1],'gallery-answer-2','Skip');
    await settle();
    if(after){
      assert.equal(questions().at(-1)?.nativeQuestion.id,textCard.id);
      answer=answerFor(textCard,'gallery-answer-after','Yes');await settle();
    }
    rows.push({role:'assistant',nativeMessage:true,siteId:'chat-message-final',text:'Selection received.',complete:true});
    notify();await settle();
    const selected=[[0,'Image 2'],[1,'Skip']];
    if(before) selected.unshift(['text','Yes']);
    if(after) selected.push(['text','Yes']);
    assert.deepEqual(clicked,selected);
    assert.deepEqual(events.filter(event=>event.kind==='sent').map(event=>event.job),[
      'gallery-request',...(before?['gallery-answer-before']:[]),'gallery-answer-1','gallery-answer-2',...(after?['gallery-answer-after']:[])]);
    const final=events.filter(event=>event.kind==='assistant'&&!event.nativeQuestion);
    assert.deepEqual(final.map(event=>[event.replyTo,event.text]),[[after?'gallery-answer-after':'gallery-answer-2','Selection received.']]);
  });
}
