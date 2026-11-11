import {escapeHtml, validatePublicOrigin} from './ph-guide-mail.mjs';
const DEFINITIONS = {
  verify: ['Verify your email', 'verify', 'Verify email'],
  checkout: ['Your US$19 setup guide', 'checkout', 'Continue to secure checkout'],
  reminder: ['Your registered subscription end date', 'checkout', 'Review your subscription'],
  guide: ['Payment confirmed - your setup guide', 'guide', 'Open your private guide'],
};
export function buildInternationalMail({kind,publicUrl,token,unsubscribeToken,expiryDate,connectionTransport='pending'}) {
  if (!Object.hasOwn(DEFINITIONS,kind) || typeof token!=='string' || !token || token.length>2048 || /[\x00-\x20\x7f]/.test(token)) throw new TypeError('Invalid mail');
  const origin=validatePublicOrigin(publicUrl), [title,path,button]=DEFINITIONS[kind];
  const action=new URL('/en/'+path,origin);action.searchParams.set('token',token);
  const paragraphs=kind==='verify'?['Please verify the email address used to request your guide. This link expires in 24 hours. If you did not request it, ignore this email.',expiryDate?'Registered subscription end date: '+expiryDate:'After verification, you can review the service and continue to checkout.']:kind==='checkout'?['Your email is verified. The setup guide fee is US$19, paid once through Paddle. This email is not a payment receipt.','Your ChatGPT subscription is separate and is paid directly to OpenAI.']:kind==='reminder'?['Registered subscription end date: '+expiryDate,'Check your own ChatGPT account to confirm that the previous paid subscription has actually ended before purchasing again. Reminders use 10:00 AM Korea Standard Time (UTC+9); the local calendar date may differ.']:['Your US$19 setup guide payment has been verified. Your private guide is available for 30 days from payment.','Read the guide before selecting Start connection. Your one-hour connection begins only when you explicitly start it. Keep your private link and connection credentials confidential.'];
  if (kind==='guide') paragraphs.push(...[
    '1. Preparation: use a Windows PC. Check that your existing ChatGPT subscription has fully ended and your account is on the free plan. Record your current Windows proxy settings.',
    connectionTransport==='wss-tunnel'?'2. Connection tool: download the Windows connection tool from your private guide, extract the entire ZIP, and run START.cmd. Wait for the local ready status.':'2. Connection: open the private guide to view the connection method. Do not use fixed sample credentials.',
    '3. Start: when ready, select Start connection in the private guide. Your one-hour session starts now. Use only the address, port, username and password issued to you.',
    '4. Windows: open Settings > Network & internet > Proxy > Manual proxy setup. Select Set up or Edit, enable Use a proxy server, enter the address and port shown in your private guide, then Save.',
    '5. Authentication: if the browser requests proxy credentials, enter the issued username and password. Keep your own ChatGPT account password and card information private.',
    '6. ChatGPT: use your own account on the official ChatGPT website. Open your profile menu, select the plan or upgrade option and review the available Pro tiers. Labels and eligibility may vary.',
    '7. Billing: enter your own accurate billing country, address and tax information. Practice examples in the guide are not valid billing details. Compare the actual plan, currency, tax and total before payment.',
    '8. Payment: only pay OpenAI if you agree to the official checkout total. If the total differs, stop and ask for help. Do not repeat a payment before checking for an existing charge.',
    '9. Finish: restore your original Windows proxy settings. If using the connection tool, run STOP.cmd. Expiry of the connection does not automatically restore Windows settings.',
  ]);
  const notes=['Windows PC required. A phone or tablet can read this email but cannot complete the Windows setup.','Regional availability, tax eligibility, payment acceptance and future renewal prices depend on your actual circumstances. No universal discount or tax exemption is guaranteed.','Support: kbhjjan@naver.com. WhatsApp: https://wa.me/qr/ZLYDDZ6W77XTG1','Independent guidance service. Not affiliated with or endorsed by OpenAI.'];
  let unsubscribe='';if(unsubscribeToken){const url=new URL('/en/unsubscribe',origin);url.searchParams.set('token',unsubscribeToken);unsubscribe=url.href;}
  const text=[title,...paragraphs,...notes,button+':\n'+action.href,...(unsubscribe?['Unsubscribe from end-date reminders:\n'+unsubscribe]:[])].join('\n\n');
  return {subject:'[Pro Route] '+title,text,html:renderInternationalMail('[Pro Route] '+title,text,origin).html};
}
export function renderInternationalMail(subject,text,publicUrl){
  const origin=validatePublicOrigin(publicUrl);
  if(typeof subject!=='string'||/[\r\n\x00-\x1f\x7f]/.test(subject)||typeof text!=='string')throw new TypeError('Invalid mail');
  const blocks=text.split(/\n\n+/).map(part=>{
    let html=escapeHtml(part).replaceAll('\n','<br>');
    for(const match of part.matchAll(/https:\/\/[^\s<>"']+/g)){
      try{const url=new URL(match[0]);const service=url.origin===origin&&/^\/en\/(verify|checkout|guide|unsubscribe)$/.test(url.pathname)&&[...url.searchParams.keys()].join(',')==='token'&&url.searchParams.get('token')&&!url.hash&&!url.username&&!url.password;
        const support=url.href==='https://wa.me/qr/ZLYDDZ6W77XTG1';
        if(service||support)html=html.replace(escapeHtml(match[0]),'<a href="'+escapeHtml(url.href)+'" style="color:#00836c;word-break:break-all">'+(service?'Open secure link':'Chat on WhatsApp')+'</a>');
      }catch{/* Unknown URLs remain escaped text. */}
    }
    return '<p style="line-height:1.7;margin:0 0 18px">'+html+'</p>';
  }).join('');
  return{subject,text,html:'<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body style="margin:0;background:#f4f7f5;color:#152b27;font:16px Arial,sans-serif"><main style="max-width:640px;margin:24px auto;padding:32px;background:#fff;border-radius:16px"><h1 style="font-size:24px">Pro Route</h1>'+blocks+'</main></body></html>'};
}
