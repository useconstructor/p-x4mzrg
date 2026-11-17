import {Suspense} from 'react';
import {Discovery} from '@/components/raiz/discovery';
import {Loading} from '@/components/raiz/common';
export const metadata={title:'Encuentra tu práctica'};
export default function Classes(){return <div className="shell"><Suspense fallback={<Loading/>}><Discovery/></Suspense></div>}
