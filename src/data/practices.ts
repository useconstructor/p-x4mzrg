import type { Practice, Instructor } from '@/lib/raiz/types';
/** User-supplied fictional demonstration catalogue. Availability always comes from the API. */
export const practices: Practice[] = [
  { id:'yoga-suave',name:'Yoga suave',discipline:'yoga',level:'Inicial',durationMinutes:60,priceCOP:30000,diagramKey:'yoga-suave',presentationVersion:1,version:1 },
  { id:'yoga-fluido',name:'Yoga fluido',discipline:'yoga',level:'Intermedio',durationMinutes:60,priceCOP:35000,diagramKey:'yoga-fluido',presentationVersion:1,version:1 },
  { id:'pilates-fundamentos',name:'Pilates fundamentos',discipline:'pilates',level:'Inicial',durationMinutes:50,priceCOP:30000,diagramKey:'pilates-fundamentos',presentationVersion:1,version:1 },
  { id:'pilates-control',name:'Pilates control',discipline:'pilates',level:'Intermedio',durationMinutes:50,priceCOP:35000,diagramKey:'pilates-control',presentationVersion:1,version:1 },
];
export const practiceCopy: Record<string,{lead:string;description:string;rhythm:string}> = {
 'yoga-suave':{lead:'Un comienzo sin prisa.',description:'Una práctica de nivel inicial. Ondas amplias y espaciadas para representar un ritmo pausado.',rhythm:'Amplitud y pausa'},
 'yoga-fluido':{lead:'Encuentra la continuidad.',description:'Una práctica de nivel intermedio. Una línea continua acompaña su referencia de movimiento.',rhythm:'Movimiento continuo'},
 'pilates-fundamentos':{lead:'Empieza por tu base.',description:'Una práctica de nivel inicial. Líneas paralelas representan apoyo y una base compartida.',rhythm:'Apoyo y estabilidad'},
 'pilates-control':{lead:'Atención en cada intervalo.',description:'Una práctica de nivel intermedio. Intervalos precisos dan forma a su referencia visual.',rhythm:'Precisión y ritmo'},
};
export const instructors: Instructor[] = [{id:'ana',name:'Ana'},{id:'lucia',name:'Lucía'},{id:'sara',name:'Sara'},{id:'valentina',name:'Valentina'}];
export const demoNotice = 'Raíz es un negocio ficticio de ejemplo en Cali; oferta, precios, perfiles e imágenes son ilustrativos';
