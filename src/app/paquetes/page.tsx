import {Suspense} from 'react';
import {PurchaseBooking} from '@/components/raiz/flows';
import {Loading} from '@/components/raiz/common';
export const metadata={title:'Paquetes para tu práctica'};
export default function Page(){return <div className="shell"><Suspense fallback={<Loading/>}><PurchaseBooking kind="purchase"/></Suspense></div>}
