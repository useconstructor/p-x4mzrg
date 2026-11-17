'use client';
import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {VisitorSession} from './types';
export class ApiError extends Error { constructor(public code:string,message:string,public fields:Record<string,string>={},public current?:unknown,public status=0){super(message);} }
export async function api<T>(path:string,init?:RequestInit):Promise<T>{
 const res=await fetch(path,{credentials:'same-origin',cache:'no-store',...init,headers:{...init?.headers},signal:init?.signal??AbortSignal.timeout(18000)});
 const body=await res.json().catch(()=>null);
 if(!res.ok)throw new ApiError(body?.error?.code||'UNAVAILABLE',body?.error?.message||'No pudimos completar la consulta. Inténtalo de nuevo.',body?.error?.fields,body?.error?.current,res.status);
 if(!body||!('data'in body))throw new ApiError('UNAVAILABLE','La respuesta no está disponible. Vuelve a consultar.');return body.data;
}
export const post=<T,>(path:string,payload:unknown,csrfToken?:string,key?:string)=>api<T>(path,{method:'POST',headers:{'Content-Type':'application/json',...(csrfToken?{'X-CSRF-Token':csrfToken}:{}),...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(payload)});
export function useRead<T>(path:string|null){
 const [state,setState]=useState<{path:string|null;revision:number;data:T|null;error:Error|null}>({path:null,revision:-1,data:null,error:null});const [revision,setRevision]=useState(0);
 const refresh=useCallback(()=>setRevision(v=>v+1),[]);
 useEffect(()=>{if(!path)return;const ac=new AbortController();api<T>(path,{signal:ac.signal}).then(data=>{if(!ac.signal.aborted)setState({path,revision,data,error:null})}).catch(error=>{if(!ac.signal.aborted)setState(prev=>({path,revision,data:prev.path===path?prev.data:null,error}))});return()=>ac.abort()},[path,revision]);
 const loading=!!path&&(state.path!==path||state.revision!==revision);
 return {data:path===state.path?state.data:null,error:loading?null:path===state.path?state.error:null,loading,refresh,setData:(data:T)=>setState({path,revision,data,error:null})};
}
let initializing:Promise<VisitorSession>|null=null;
function markerKey(){if(window.top===window.self)return 'raiz-session-expected:direct';const ancestors=(window.location as Location&{ancestorOrigins?:DOMStringList}).ancestorOrigins;const top=ancestors?.length?ancestors[ancestors.length-1]:null;return top?'raiz-session-expected:embed:'+top:'raiz-session-expected:embed:unknown';}
function mark(){try{localStorage.setItem(markerKey(),'1')}catch{/* Cookie verification, never storage, is the authority. */}}
async function establish(recover:boolean){
 try{const s=await api<VisitorSession>('/api/sesion');mark();return s}catch(e){if(!(e instanceof ApiError)||e.status!==401)throw e;}
 let expected=false;try{expected=!!localStorage.getItem(markerKey())||!!localStorage.getItem('raiz-session-expected')}catch{expected=true;}
 if(expected&&!recover)throw new ApiError('SESSION_LOST','No pudimos mantener tu sesión. Recupera el acceso explícitamente antes de continuar.');
 await post('/api/sesion',{});const checked=await api<VisitorSession>('/api/sesion');mark();return checked;
}
export function visitorSession(recover=false):Promise<VisitorSession>{if(!initializing){const work=()=>establish(recover);async function run(){return navigator.locks?await navigator.locks.request('raiz-visitor-session',work):await work()}initializing=run().finally(()=>{initializing=null})}return initializing;}
export function useVisitor(){const [session,setSession]=useState<VisitorSession|null>(null);const [error,setError]=useState<Error|null>(null);const [loading,setLoading]=useState(true);const alive=useRef(true);const load=useCallback((recover=false)=>visitorSession(recover).then(s=>{if(alive.current){setSession(s);setError(null)}}).catch(e=>{if(alive.current){setSession(null);setError(e)}}).finally(()=>{if(alive.current)setLoading(false)}),[]);useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false}},[load]);function retry(recover=false){setLoading(true);setError(null);void load(recover)}return {session,error,loading,retry:()=>retry(),recover:()=>retry(true)};}
export function trackBooking(){(window as Window&{constructorTrack?:(event:string)=>void}).constructorTrack?.('Booking started');}
export type PendingOperation<T>={key:string;operation:string;path:string;payload:T};

function subscribeHash(callback:()=>void){addEventListener('hashchange',callback);addEventListener('popstate',callback);return()=>{removeEventListener('hashchange',callback);removeEventListener('popstate',callback)}}
export function useLocationHash(){return useSyncExternalStore(subscribeHash,()=>location.hash,()=>'')}
