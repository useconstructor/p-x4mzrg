import type {Metadata} from 'next';
import type {CSSProperties,ReactNode} from 'react';
import branding from '../../branding.json';
import {localFonts} from '@/lib/raiz/brand-assets';
import {Header,Footer,FragmentFocus,FontReadiness} from '@/components/raiz/common';
import './globals.css';
import './flow-repair.css';
export const metadata:Metadata={title:{default:'Raíz — Vuelve a tu raíz',template:'%s | Raíz'},description:'Encuentra tu práctica de yoga y pilates en Cali. Clases, horarios y reservas de un estudio ficticio de ejemplo.',icons:{icon:'/icon.svg',apple:'/brand-mark.svg'},manifest:'/manifest.webmanifest'};
export default function RootLayout({children}:{children:ReactNode}){
 const fontCSS=branding.brandbook.fontFaces.map(f=>`@font-face{font-family:${JSON.stringify(f.family)};font-style:normal;font-weight:${f.weight};font-display:swap;src:url(${JSON.stringify(localFonts[f.url]||f.url)}) format('truetype');}`).join('\n');
 const api=process.env.NEXT_PUBLIC_CONSTRUCTOR_API?.replace(/\/$/,'')||'https://constructor-api-git-dev-useconstructor.vercel.app';
 const project=process.env.NEXT_PUBLIC_PROJECT_ID||'P-X4MZRG';
 const style={'--brand-background':branding.backgroundColor,'--brand-surface':branding.secondaryColor,'--brand-primary':branding.primaryColor,'--brand-accent':branding.accentColor,'--brand-text':branding.textColor,'--brand-font-heading':`"${branding.fontHeading}", sans-serif`,'--brand-font-body':`"${branding.fontBody}", sans-serif`} as CSSProperties;
 return <html lang="es" style={style}><head><style dangerouslySetInnerHTML={{__html:fontCSS}}/></head><body><a href="#contenido" className="skip-link">Saltar al contenido</a><FontReadiness/><Header/><FragmentFocus/><main>{children}</main><Footer/><script src={"https://constructor-api-git-dev-useconstructor.vercel.app/v1/projects/P-X4MZRG/analytics/script.js"} defer></script><script src="/constructor-editor.js" defer/></body></html>;
}
