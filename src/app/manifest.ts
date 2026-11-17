import type {MetadataRoute} from 'next';
import branding from '../../branding.json';
export default function manifest():MetadataRoute.Manifest{return {name:branding.logoText,short_name:branding.logoText,start_url:'/',display:'standalone',background_color:branding.backgroundColor,theme_color:branding.secondaryColor,icons:[{src:'/brand-mark.svg',sizes:'any',type:'image/svg+xml',purpose:'any'}]}}
