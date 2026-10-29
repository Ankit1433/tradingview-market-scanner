// One shared send path for signal alerts, bot replies, admin notices and personal reminders.
function createDelivery({accounts,send,clock=()=>new Date(),canSend=()=>true}){
 const busy=new Set();
 return async function deliver(user,text){const chat=user.telegram_chat_id;if(!canSend()||!chat||busy.has(chat))return{deferred:true};
  const now=clock();const fresh=await accounts.user(user.id);if(!fresh?.telegram_chat_id||fresh.telegram_chat_id!==chat)return{deferred:true};
  if(Date.parse(fresh.telegram_next_at)>now.getTime())return{deferred:true};
  busy.add(chat);try{
   if(!canSend())return{deferred:true};
   const response=await send('sendMessage',{chat_id:chat,text});
   await accounts.controls(user.id,{telegram_next_at:new Date(now.getTime()+1100).toISOString()});
   return response?.ok?{sent:true}:{deferred:true};
  }catch(error){const seconds=Number(error.response?.data?.parameters?.retry_after);const retry=error.response?.status===429?Math.max(seconds||1,1)*1000:30000;
   await accounts.controls(user.id,{telegram_next_at:new Date(now.getTime()+retry).toISOString()});return{deferred:true,retryAt:new Date(now.getTime()+retry).toISOString()};
  }finally{busy.delete(chat);}
 };
}
module.exports={createDelivery};
