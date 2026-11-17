import {Suspense} from 'react';
import {PurchaseBooking} from '@/components/raiz/flows';
import {Loading} from '@/components/raiz/common';
export const metadata={title:'Reserva tu espacio',robots:{index:false,follow:false}};
export default async function Page({params}:{params:Promise<{sesion:string}>}){const {sesion}=await params;return <div className="shell"><Suspense fallback={<Loading/>}><PurchaseBooking kind="reservation" sessionId={sesion}/></Suspense></div>}
