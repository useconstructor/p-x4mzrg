import {Suspense} from 'react';
import {ConfirmationPage} from '@/components/raiz/flows';
import {Loading} from '@/components/raiz/common';
export const metadata={title:'Resultado de tu solicitud',robots:{index:false,follow:false}};
export default async function Page({params}:{params:Promise<{referencia:string}>}){const {referencia}=await params;return <div className="shell"><Suspense fallback={<Loading/>}><ConfirmationPage reference={referencia}/></Suspense></div>}
