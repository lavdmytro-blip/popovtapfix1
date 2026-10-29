// POPOV TAP reference server — Node.js 20+, no npm dependencies.
// Production needs a persistent database, TLS reverse proxy, monitoring and payment review.
const http=require('node:http'), fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Pool}=require('pg');
const TOKEN=process.env.BOT_TOKEN||'',PORT=Number(process.env.PORT||3000),PUBLIC_URL=process.env.PUBLIC_URL||'';
if(!process.env.DATABASE_URL){console.error('DATABASE_URL is required');process.exit(1)}
const pool=new Pool({connectionString:process.env.DATABASE_URL, max:5, ssl:process.env.PGSSL==='true'?{rejectUnauthorized:false}:undefined});
let store={users:{},charges:{}};
// Single-instance MVP: serialize API requests, then atomically persist game state in PostgreSQL.
let work=Promise.resolve();function serialized(fn){let job=work.then(fn);work=job.catch(()=>{});return job}

const sessions=new Map();const recents=new Map();const upgrades={tap:75,energy:140,regen:230,auto:500};const skinPrices={neon:25,pink:40};const coinSkins={ember:2500,frost:8500,royal:25000};const skinBonus={classic:{},ember:{tap:1},frost:{regen:1},royal:{tap:2,passive:120},neon:{},pink:{}};const rewards={'100':500,'500':3000,'2000':15000};
async function write(){await pool.query('UPDATE game_state SET state=$1::jsonb WHERE id=1',[JSON.stringify(store)])}
function initial(){return {balance:0,totalTaps:0,energy:1000,last:Date.now(),upgrades:{tap:0,energy:0,regen:0,auto:0},skin:'classic',skins:['classic'],claimed:[]}}
function bonus(p,key){return (skinBonus[p.skin]||{})[key]||0}function maxEn(p){return 1000+300*p.upgrades.energy}function regen(p){return 1+.75*p.upgrades.regen+bonus(p,'regen')}function passive(p){return 120*p.upgrades.auto+bonus(p,'passive')}
function tick(p){let now=Date.now(),dt=Math.min(86400,Math.max(0,(now-p.last)/1000));p.energy=Math.min(maxEn(p),p.energy+dt*regen(p));p.balance+=dt*passive(p)/3600;p.last=now}
function verify(initData){if(!TOKEN)throw Error('BOT_TOKEN не настроен');let q=new URLSearchParams(initData),hash=q.get('hash'),auth=Number(q.get('auth_date'));if(!hash||!auth||Math.abs(Date.now()/1000-auth)>86400)throw Error('Недействительная или устаревшая авторизация');q.delete('hash');q.delete('signature');const check=[...q].sort((a,b)=>a[0].localeCompare(b[0])).map(([k,v])=>k+'='+v).join('\n');const secret=crypto.createHmac('sha256','WebAppData').update(TOKEN).digest();const got=crypto.createHmac('sha256',secret).update(check).digest('hex');if(hash.length!==got.length||!crypto.timingSafeEqual(Buffer.from(hash),Buffer.from(got)))throw Error('Ошибка подписи Telegram');const user=JSON.parse(q.get('user')||'null');if(!user?.id)throw Error('Нужен запуск через Telegram');return user}
function json(res,status,obj){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(obj))}
function body(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>10000){reject(Error('Большой запрос'));req.destroy()}});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'))}catch(e){reject(Error('Ошибка JSON'))}})})}
async function bot(method,params){let r=await fetch('https://api.telegram.org/bot'+TOKEN+'/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(params)});let v=await r.json();if(!v.ok)throw Error('Telegram API: '+v.description);return v.result}
async function route(req,res){let url=new URL(req.url,'http://localhost'),p=url.pathname;if(req.method==='GET'&&!p.startsWith('/api/')){let file=p==='/'?'index.html':p.slice(1);if(!['index.html','coin.png'].includes(file))return json(res,404,{error:'Not found'});let data=fs.readFileSync(path.join(__dirname,'public',file));res.writeHead(200,{'content-type':file.endsWith('png')?'image/png':'text/html; charset=utf-8','cache-control':'public,max-age=600'});return res.end(data)}if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});let data=await body(req);
if(p==='/api/auth'){let user=verify(data.initData||'');let id=String(user.id);store.users[id]??=initial();const displayName=[user.first_name,user.last_name].filter(Boolean).join(' ').trim().slice(0,70);store.users[id].profile={username:(user.username||'').slice(0,35),name:displayName||'Игрок POPOV',photo_url:/^https:\/\//.test(user.photo_url||'')?user.photo_url.slice(0,1000):''};tick(store.users[id]);await write();let session=crypto.randomBytes(32).toString('hex');sessions.set(session,{id,expires:Date.now()+86400000});return json(res,200,{session,player:store.users[id],profile:{id:user.id,first_name:user.first_name||'',last_name:user.last_name||'',username:user.username||'',photo_url:user.photo_url||''}})}
let s=sessions.get(req.headers['x-popov-session']);if(!s||s.expires<Date.now())return json(res,401,{error:'Открой игру из Telegram'});let id=s.id,player=store.users[id];tick(player);
if(p==='/api/tap'){let count=Number(data.count);if(!Number.isInteger(count)||count<1||count>40)throw Error('Некорректное число тапов');let now=Date.now(),rate=recents.get(id)||{at:now,count:0};if(now-rate.at>1000)rate={at:now,count:0};rate.count+=count;recents.set(id,rate);if(rate.count>20)throw Error('Слишком быстро');let done=Math.min(count,Math.floor(player.energy));player.energy-=done;player.totalTaps+=done;player.balance+=done*(1+player.upgrades.tap+bonus(player,'tap'));await write();return json(res,200,{player})}
if(p==='/api/upgrade'){let key=data.id;if(!Object.hasOwn(upgrades,key))throw Error('Нет такого улучшения');let level=player.upgrades[key];if(level>=100)throw Error('Максимальный уровень');let cost=Math.round(upgrades[key]*Math.pow(1.65,level));if(player.balance<cost)throw Error('Недостаточно очков');player.balance-=cost;player.upgrades[key]++;await write();return json(res,200,{player})}
if(p==='/api/skin-buy'){let key=data.id,price=coinSkins[key];if(!price)throw Error('Нет такого скина');if(player.skins.includes(key))throw Error('Скин уже куплен');if(player.balance<price)throw Error('Недостаточно очков');player.balance-=price;player.skins.push(key);player.skin=key;await write();return json(res,200,{player})}
if(p==='/api/equip'){if(!player.skins.includes(data.id))throw Error('Скин не куплен');player.skin=data.id;await write();return json(res,200,{player})}
if(p==='/api/claim'){let k=String(data.id);if(!rewards[k]||player.claimed.includes(k)||player.totalTaps<Number(k))throw Error('Награда недоступна');player.balance+=rewards[k];player.claimed.push(k);await write();return json(res,200,{player})}
if(p==='/api/leaderboard'){
  // Rankings always come from the server, never from a supplied client score.
  let ranked=Object.entries(store.users).map(([uid,entry])=>{tick(entry);return {uid,score:Math.floor(Math.max(0,entry.balance||0)),username:entry.profile?.username||'',name:entry.profile?.name||'Игрок POPOV',photo_url:entry.profile?.photo_url||''}}).sort((a,b)=>b.score-a.score||a.uid.localeCompare(b.uid));
  let myRank=ranked.findIndex(x=>x.uid===id)+1;
  const publicItem=(entry,idx)=>({rank:idx+1,score:entry.score,username:entry.username,name:entry.name,photo_url:entry.photo_url,isMe:entry.uid===id});
  let top=ranked.slice(0,100).map(publicItem);
  await write();return json(res,200,{top,myRank,myScore:Math.floor(Math.max(0,player.balance||0)),total:ranked.length});
}
if(p==='/api/state'){await write();return json(res,200,{player})}
if(p==='/api/invoice'){let key=data.id,price=skinPrices[key];if(!price)throw Error('Товар не найден');if(player.skins.includes(key))throw Error('Скин уже куплен');let payload=JSON.stringify({id,skin:key,nonce:crypto.randomBytes(8).toString('hex')});let link=await bot('createInvoiceLink',{title:'POPOV TAP — '+key,description:'Постоянный косметический скин в игре POPOV TAP',payload,provider_token:'',currency:'XTR',prices:[{label:'Cosmetic skin',amount:price}]});return json(res,200,{url:link})}
return json(res,404,{error:'Not found'})}
// Telegram long polling for payment updates. Do not use simultaneously with a configured webhook.
async function poll(){if(!TOKEN)return;let offset=0;while(true){try{let list=await bot('getUpdates',{offset,timeout:25,allowed_updates:['pre_checkout_query','message']});for(let u of list){offset=u.update_id+1;if(u.pre_checkout_query){let q=u.pre_checkout_query,valid=false;try{let item=JSON.parse(q.invoice_payload);valid=String(q.from.id)===item.id && skinPrices[item.skin]===q.total_amount && q.currency==='XTR'&&!!store.users[item.id]}catch(_){}await bot('answerPreCheckoutQuery',{pre_checkout_query_id:q.id,ok:valid,...(!valid?{error_message:'Счёт недействителен'}:{})})}if(u.message?.successful_payment){let pay=u.message.successful_payment;try{let item=JSON.parse(pay.invoice_payload);let charge=pay.telegram_payment_charge_id;if(!store.charges[charge]&&String(u.message.from.id)===item.id&&pay.currency==='XTR'&&skinPrices[item.skin]===pay.total_amount&&store.users[item.id]){store.charges[charge]={id:item.id,skin:item.skin,time:Date.now()};let player=store.users[item.id];if(!player.skins.includes(item.skin))player.skins.push(item.skin);await write();await bot('sendMessage',{chat_id:item.id,text:'✅ Скин '+item.skin+' успешно получен! Открой POPOV TAP → Скины.'})}}catch(e){console.error('Payment fulfillment failed',e)}}}}catch(e){console.error('Polling:',e.message);await new Promise(r=>setTimeout(r,4000))}}}
async function boot(){
 await pool.query('CREATE TABLE IF NOT EXISTS game_state (id INTEGER PRIMARY KEY, state JSONB NOT NULL)');
 await pool.query("INSERT INTO game_state (id,state) VALUES (1, '{\"users\":{},\"charges\":{}}'::jsonb) ON CONFLICT (id) DO NOTHING");
 const result=await pool.query('SELECT state FROM game_state WHERE id=1');
 store=result.rows[0].state;
 const server=http.createServer((req,res)=>{
   if(req.method==='GET')return route(req,res).catch(e=>json(res,400,{error:e.message}));
   serialized(()=>route(req,res)).catch(e=>json(res,400,{error:e.message}));
 });
 server.listen(PORT,'0.0.0.0',()=>console.log('POPOV TAP online on port '+PORT));
 poll();
}
boot().catch(e=>{console.error('Database startup failed:',e.message);process.exit(1)});
