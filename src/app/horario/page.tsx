import {Suspense} from 'react';
import {SchedulePage} from '@/components/raiz/schedule';
import {Loading} from '@/components/raiz/common';
export const metadata={title:'Horario semanal'};
export default function Page(){return <div className="shell schedule-page"><Suspense fallback={<Loading/>}><SchedulePage/></Suspense></div>}
