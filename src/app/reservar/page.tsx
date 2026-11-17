import {Suspense} from 'react';
import {PurchaseBooking} from '@/components/raiz/flows';
import {Loading} from '@/components/raiz/common';
export const metadata={title:'Reserva tu espacio',robots:{index:false,follow:false}};
export default function Page(){return <div className="shell"><Suspense fallback={<Loading/>}><PurchaseBooking kind="reservation"/></Suspense></div>}
