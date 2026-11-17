'use client';
import {ErrorBox,PageHeading} from '@/components/raiz/common';
export default function ErrorPage({reset}:{error:Error&{digest?:string};reset:()=>void}){return <div className="shell"><PageHeading title="Necesitamos volver a intentarlo"/><ErrorBox error="No pudimos abrir esta página. Puedes reintentar la consulta; no repitas una compra o reserva sin comprobar antes su resultado." retry={reset}><a className="text-link" href="/mis-clases">Consultar Mis clases</a></ErrorBox></div>}
