const {EventEmitter}=require('events');
const path=require('path');
const protobuf=require('protobufjs');
const WS=require('ws');
class Feed extends EventEmitter {
 constructor({provider,Socket=WS,clock=Date.now,schedule=setTimeout,cancel=clearTimeout,maxSubscriptions=500,maxAttempts=12}={}){super();this.provider=provider;this.Socket=Socket;this.clock=clock;this.schedule=schedule;this.cancel=cancel;this.maxSubscriptions=maxSubscriptions;this.maxAttempts=maxAttempts;this.keys=new Set();this.socket=null;this.timer=null;this.watchdog=null;this.stopped=true;this.connecting=false;this.attempts=0;this.lastMessage=0;this.lastQuote=null;this.state='stopped';this.quotes=new Map();}
 async decode(data){if(!this.type){const root=await protobuf.load(path.join(__dirname,'MarketDataFeed.proto'));this.type=root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');}return this.type.toObject(this.type.decode(data),{longs:String,enums:String});}
 subscription(method,keys){if(this.socket?.readyState===1)this.socket.send(Buffer.from(JSON.stringify({guid:require('crypto').randomUUID(),method,data:{mode:'ltpc',instrumentKeys:keys}})));}
 subscribe(keys){const next=new Set([...this.keys,...keys]);if(next.size>this.maxSubscriptions)throw Error('UPSTOX_SUBSCRIPTION_LIMIT');this.keys=next;this.subscription('sub',keys);}
 unsubscribe(keys){keys.forEach(k=>{this.keys.delete(k);this.quotes.delete(k);});this.subscription('unsub',keys);}
 async start(){if(!this.stopped)return;this.stopped=false;await this.connect();}
 async connect(){if(this.stopped||this.connecting||this.socket)return;this.connecting=true;this.state='connecting';try{const data=await this.provider.request('/v3/feed/market-data-feed/authorize');if(this.stopped)return;const url=new URL(data.authorized_redirect_uri);if(url.protocol!=='wss:'||!/(^|\.)upstox\.com$/.test(url.hostname))throw Error('UPSTOX_FEED_URL_INVALID');const socket=new this.Socket(url.toString(),{handshakeTimeout:12000});this.socket=socket;
 socket.on('open',()=>{this.state='connected';this.lastMessage=this.clock();this.subscription('sub',[...this.keys]);this.watchdog=setInterval(()=>{if(this.clock()-this.lastMessage>60000)socket.terminate();},15000);this.watchdog.unref?.();this.emit('reconnected');});
 socket.on('ping',()=>{this.lastMessage=this.clock();});
 socket.on('message',async data=>{this.lastMessage=this.clock();try{const decoded=await this.decode(data);this.attempts=0;for(const [key,value]of Object.entries(decoded.feeds||{})){if(!this.keys.has(key))continue;const quote=value.ltpc||value.fullFeed?.marketFF?.ltpc||value.fullFeed?.indexFF?.ltpc;if(quote&&Number.isFinite(quote.ltp)){this.quotes.set(key,{...quote,receivedAt:this.clock()});this.lastQuote=this.clock();}}this.emit('data',decoded);}catch(_){this.state='decode-error';socket.terminate();}});
 socket.on('error',()=>{this.state='connection-error';socket.terminate();});socket.on('close',()=>{clearInterval(this.watchdog);if(this.socket===socket)this.socket=null;this.retry();});
 }catch(_){this.state='authorization-or-network-error';this.retry();}finally{this.connecting=false;}}
 retry(){if(this.stopped||this.timer||this.provider.blocked)return;if(this.attempts>=this.maxAttempts){this.state='retry-limit';return;}this.state='reconnecting';const ms=Math.min(60000,1000*2**this.attempts++)+Math.floor(Math.random()*500);this.timer=this.schedule(()=>{this.timer=null;this.connect();},ms);this.timer?.unref?.();}
 stop(){this.stopped=true;this.cancel(this.timer);this.timer=null;clearInterval(this.watchdog);this.socket?.terminate();this.socket=null;this.state='stopped';}
 status(){return {state:this.state,subscriptions:this.keys.size,lastTransportUpdate:this.lastMessage?new Date(this.lastMessage).toISOString():null,lastQuoteUpdate:this.lastQuote?new Date(this.lastQuote).toISOString():null,quoteOnly:true};}
}
module.exports={Feed};
