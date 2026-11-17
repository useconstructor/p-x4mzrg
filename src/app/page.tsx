import {Suspense} from 'react';
import {Discovery} from '@/components/raiz/discovery';
import {Loading} from '@/components/raiz/common';
export default function Home(){return <div className="shell"><Suspense fallback={<Loading/>}><Discovery home/></Suspense></div>}
