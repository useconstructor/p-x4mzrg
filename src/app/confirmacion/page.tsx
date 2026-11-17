import {Suspense} from 'react';
import {ConfirmationPage} from '@/components/raiz/flows';
import {Loading} from '@/components/raiz/common';
export const metadata={title:'Resultado de tu solicitud',robots:{index:false,follow:false}};
export default function Page(){return <div className="shell"><Suspense fallback={<Loading/>}><ConfirmationPage/></Suspense></div>}
