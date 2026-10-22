// SVG cleaning and pixel-to-rectangle merge, shared with the LOVELACE web
// silkscreen editor (0.025 mm stencil). build.py copies this into ui.html.
function maskRectangles(pixels,width,height,ignoreWhite) {
  let active=new Map(); const output=[];
  function ink(x,y) {const i=(y*width+x)*4; return pixels[i+3]>=128&&(!ignoreWhite||Math.min(pixels[i],pixels[i+1],pixels[i+2])<245);}
  for(let y=0;y<height;y++) {
    const next=new Map();
    for(let x=0;x<width;) {
      if(!ink(x,y)){x++;continue;}
      const start=x;while(x<width&&ink(x,y))x++;
      const key=`${start}:${x}`, rect=active.get(key)||[start,y,x-start,0]; rect[3]++;
      next.set(key,rect); active.delete(key);
    }
    output.push(...active.values()); active=next;
  }
  output.push(...active.values());
  return output.map(([x,y,w,h])=>[x/width,y/height,w/width,h/height]);
}
function cleanSVG(source) {
  if(new TextEncoder().encode(source).length>512000)throw new Error('SVG는 500 KB 이하만 지원합니다.');
  const doc=new DOMParser().parseFromString(source,'image/svg+xml');
  if(doc.querySelector('parsererror')||doc.documentElement.localName!=='svg')throw new Error('올바른 SVG 파일이 아닙니다.');
  if(doc.doctype)throw new Error('DOCTYPE을 제거한 일반 SVG로 저장하세요.');
  for(const element of doc.querySelectorAll('*')) {
    if(['script','foreignObject','animate','animateMotion','animateTransform','set','image'].includes(element.localName))throw new Error('외부 이미지·스크립트·애니메이션 없이 SVG 경로로 내보내세요.');
    if(element.localName==='style'&&(/@import/i.test(element.textContent)||[...element.textContent.matchAll(/url\((.*?)\)/gi)].some(m=>!/^\s*['"]?#[\w.-]+['"]?\s*$/.test(m[1]))))throw new Error('외부 스타일 참조는 지원하지 않습니다.');
    for(const attr of element.attributes) {
      if(/^on/i.test(attr.name)||(/href$/i.test(attr.name)&&!attr.value.startsWith('#'))||(/url\s*\(/i.test(attr.value)&&!/url\(\s*['"]?#[\w.-]+['"]?\s*\)/i.test(attr.value)))throw new Error('외부 참조나 실행 코드가 있는 SVG는 지원하지 않습니다.');
    }
  }
  const svg=doc.documentElement, box=svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  let width=box?.[2]||parseFloat(svg.getAttribute('width'))||100;
  let height=box?.[3]||parseFloat(svg.getAttribute('height'))||100;
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error('SVG 크기가 잘못됐습니다.');
  svg.setAttribute('width',width);svg.setAttribute('height',height);
  return {source:new XMLSerializer().serializeToString(svg),ratio:height/width};
}
