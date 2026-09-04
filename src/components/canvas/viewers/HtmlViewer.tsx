'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, Undo2, Redo2, Loader2, X, MousePointer2, ChevronDown, ChevronUp, BookOpen, ExternalLink, Replace, Wand2, Check, LocateFixed, GitCompareArrows, SlidersHorizontal } from 'lucide-react';
import { desktop, isDesktop } from '@/lib/desktop-adapter';
import type { ViewerRenderProps } from './types';
import { DEFAULT_MODEL_ID, getAvailableModels, isCustomModel, parseCustomModel, type AvailableModel, type ProviderConfig } from '@/lib/types';
import { loadSettings } from '@/lib/settings';

// ======================= Inspector Script（注入 iframe 的元素检选脚本） =======================

const INSPECTOR_SCRIPT = `(function(){
  var hoverOv=document.createElement('div');
  hoverOv.style.cssText='position:fixed;pointer-events:none;border:2px solid rgba(59,130,246,0.5);background:rgba(59,130,246,0.08);z-index:999999;display:none;transition:all 0.05s;';
  document.body.appendChild(hoverOv);
  var selOv=document.createElement('div');
  selOv.style.cssText='position:fixed;pointer-events:none;border:2px solid rgba(249,115,22,0.9);box-shadow:0 0 0 1px rgba(249,115,22,0.3);z-index:999998;display:none;';
  document.body.appendChild(selOv);
  /** 文字级持久高亮容器：多个矩形覆盖（跨多行文本时每一行一个） */
  var textHlLayer=document.createElement('div');
  textHlLayer.style.cssText='position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;z-index:999997;overflow:visible;';
  document.body.appendChild(textHlLayer);
  var hlRects=[];
  function clearTextHl(){
    hlRects=[];
    while(textHlLayer.firstChild)textHlLayer.removeChild(textHlLayer.firstChild);
  }
  var selEl=null,rafId=null,textSelRange=null,textRafId=null;
  function stopSel(){
    selEl=null;
    if(rafId){cancelAnimationFrame(rafId);rafId=null;}
    selOv.style.display='none';
  }
  /** 选中框持续跟随：rAF 每帧把高亮框重定位到选中元素上，滚动/重排/动画时保持贴合 */
  function startSelLoop(){
    if(rafId)cancelAnimationFrame(rafId);
    (function tick(){
      if(selEl&&document.body.contains(selEl)){
        posOv(selOv,selEl);
        rafId=requestAnimationFrame(tick);
      }else{
        stopSel();
      }
    })();
  }
  /** 文字高亮持续跟随：rAF 每帧根据当前 Range 重新取 rects（滚动 / 字体动画 / 重排时保持贴合） */
  function startTextSelLoop(){
    if(textRafId)cancelAnimationFrame(textRafId);
    (function tick(){
      if(!textSelRange){return;}
      var rects=null;
      try{rects=textSelRange.getClientRects();}catch(e){rects=null;}
      if(!rects||rects.length===0){textSelRange=null;clearTextHl();textRafId=null;return;}
      if(hlRects.length!==rects.length){
        clearTextHl();
        for(var i=0;i<rects.length;i++){
          var d=document.createElement('div');
          d.style.cssText='position:fixed;pointer-events:none;background:rgba(75,63,227,0.26);border:1px solid rgba(75,63,227,0.55);border-radius:2px;';
          textHlLayer.appendChild(d);hlRects.push(d);
        }
      }
      for(var j=0;j<rects.length;j++){
        var r=rects[j];var dd=hlRects[j];
        if(!dd||!r||(r.width<1&&r.height<1)){if(dd)dd.style.display='none';continue;}
        dd.style.display='block';
        dd.style.left=r.left+'px';dd.style.top=r.top+'px';
        dd.style.width=r.width+'px';dd.style.height=r.height+'px';
      }
      textRafId=requestAnimationFrame(tick);
    })();
  }
  function buildSelector(el){
    if(el.id) return '#'+el.id;
    var parts=[];var cur=el;
    while(cur&&cur!==document.body){
      var part=cur.tagName.toLowerCase();
      if(cur.id){parts.unshift('#'+cur.id);break;}
      var cn=typeof cur.className==='string'?cur.className:'';
      if(cn) part+='.'+cn.split(/\\s+/).filter(Boolean).join('.');
      var parent=cur.parentElement;
      if(parent){
        var sibs=Array.prototype.filter.call(parent.children,function(c){return c.tagName===cur.tagName;});
        if(sibs.length>1) part+=':nth-of-type('+(sibs.indexOf(cur)+1)+')';
      }
      parts.unshift(part);
      cur=cur.parentElement;
    }
    return parts.join(' > ');
  }
  function posOv(ov,el){
    var r=el.getBoundingClientRect();
    ov.style.left=r.left+'px';ov.style.top=r.top+'px';
    ov.style.width=r.width+'px';ov.style.height=r.height+'px';
    ov.style.display='block';
  }
  document.addEventListener('mouseover',function(e){
    var el=e.target;
    if(!el||el===document.body||el===hoverOv||el===selOv||el.tagName==='SCRIPT'||el.tagName==='STYLE') return;
    if(selEl&&(el===selEl||selEl.contains(el))){hoverOv.style.display='none';return;}
    posOv(hoverOv,el);
  });
  document.addEventListener('mouseout',function(e){
    if(!e.relatedTarget) hoverOv.style.display='none';
  });
  document.addEventListener('click',function(e){
    e.preventDefault();e.stopPropagation();
    // 元素级点击：清除文字级高亮（两种高亮互斥，避免混淆）
    textSelRange=null;if(textRafId){cancelAnimationFrame(textRafId);textRafId=null;}clearTextHl();
    var el=e.target;
    if(!el||el===hoverOv||el===selOv){
      stopSel();
      window.parent.postMessage({type:'element-deselected',isTextSelection:false},'*');
      return;
    }
    if(el===document.body||el.tagName==='SCRIPT'||el.tagName==='STYLE'){
      stopSel();
      window.parent.postMessage({type:'element-deselected',isTextSelection:false},'*');
      return;
    }
    selEl=el;posOv(selOv,el);hoverOv.style.display='none';startSelLoop();
    var r=el.getBoundingClientRect();
    window.parent.postMessage({
      type:'element-selected',
      isTextSelection:false,
      element:{
        tag:el.tagName.toLowerCase(),
        id:el.id||'',
        className:(typeof el.className==='string'?el.className:''),
        selector:buildSelector(el),
        outerHTML:el.outerHTML.slice(0,2000),
        textPreview:(el.textContent||'').slice(0,80)
      },
      // 区块左下角（相对 iframe 视口）：宿主据此把 AI 编辑面板吸附到区块下方
      pos:{x:r.left,y:r.bottom}
    },'*');
  },true);
  document.addEventListener('keydown',function(e){
    if(e.key==='Escape'){
      stopSel();
      textSelRange=null;if(textRafId){cancelAnimationFrame(textRafId);textRafId=null;}clearTextHl();
      window.parent.postMessage({type:'element-deselected',isTextSelection:false},'*');
    }
  });
  // 选中即填入：监听 selectionchange，非折叠选区时自动上报文字与所在元素（按 文字+元素 去重，避免拖动选择时重复上报）
  var lastPick={t:'',s:''};
  document.addEventListener('selectionchange',function(){
    var sel=window.getSelection();
    if(!sel||sel.isCollapsed){return;}
    var text=sel.toString();
    if(!text) return;
    var node=sel.anchorNode;
    var el=node?(node.nodeType===1?node:node.parentElement):null;
    if(!el||!document.body.contains(el)) return;
    var selKey=buildSelector(el);
    // 保存 Range（cloneRange 防止后续 selection 变化影响），启动持久文字高亮
    try{
      var rng=sel.getRangeAt(0).cloneRange();
      textSelRange=rng;startTextSelLoop();
      // 元素框仍保留橙色（锚元素），让用户同时看到"在哪个元素里 + 具体哪段文字"
      selEl=el;posOv(selOv,el);startSelLoop();
    }catch(e){}
    if(lastPick.t===text&&lastPick.s===selKey) return;
    lastPick.t=text;lastPick.s=selKey;
    var short=text.length>22?text.slice(0,22)+'…':text;
    window.parent.postMessage({
      type:'html-text-selected',
      isTextSelection:true,
      text:text.slice(0,2000),
      textShort:short,
      element:{
        tag:el.tagName.toLowerCase(),
        id:el.id||'',
        className:(typeof el.className==='string'?el.className:''),
        selector:selKey,
        outerHTML:el.outerHTML.slice(0,2000),
        textPreview:(el.textContent||'').slice(0,80)
      }
    },'*');
  });
  // 父 → 子：历史定位元素 / 清除文字高亮
  window.addEventListener('message',function(e){
    var d=e.data;if(!d)return;
    if(d.type==='ba-highlight-element'&&d.selector){
      var el=document.querySelector(d.selector);
      if(!el) return;
      try{el.scrollIntoView({behavior:'smooth',block:'center'});}catch(err){}
      selEl=el;posOv(selOv,el);hoverOv.style.display='none';startSelLoop();
    }else if(d.type==='ba-clear-text-highlight'){
      textSelRange=null;if(textRafId){cancelAnimationFrame(textRafId);textRafId=null;}clearTextHl();
    }
  });
  // 语义区域自动标注
  var rules=[
    {t:function(el){return el.tagName==='HEADER'||/header|navbar/i.test(el.className+' '+el.id);},l:'Header'},
    {t:function(el){return el.tagName==='NAV'||/nav|menu/i.test(el.className+' '+el.id);},l:'Nav'},
    {t:function(el){return el.tagName==='MAIN'||/main|content|article/i.test(el.className+' '+el.id);},l:'Main'},
    {t:function(el){return el.tagName==='ASIDE'||/sidebar|aside/i.test(el.className+' '+el.id);},l:'Sidebar'},
    {t:function(el){return el.tagName==='FOOTER'||/footer/i.test(el.className+' '+el.id);},l:'Footer'},
    {t:function(el){return el.tagName==='SECTION';},l:'Section'},
    {t:function(el){return /form|contact|login|signup/i.test(el.className+' '+el.id);},l:'Form'}
  ];
  Array.prototype.forEach.call(document.body.children,function(el){
    if(el.tagName==='SCRIPT'||el.tagName==='STYLE') return;
    for(var i=0;i<rules.length;i++){
      if(rules[i].t(el)){
        el.style.outline='2px dashed rgba(83,125,150,0.35)';
        el.style.outlineOffset='2px';
        if(getComputedStyle(el).position==='static') el.style.position='relative';
        var badge=document.createElement('div');
        badge.textContent=rules[i].l;
        badge.style.cssText='position:absolute;top:-18px;left:0;font-size:12px;padding:1px 6px;background:rgba(83,125,150,0.75);color:#fff;border-radius:3px;pointer-events:none;z-index:999997;font-family:var(--font-sans);';
        el.appendChild(badge);
        break;
      }
    }
  });
})();`;

/** 翻页版结构检测（白名单）：仅当文件显式声明 deck 结构才提供翻页能力——
 *  不再因为任意 class 含 "slide" 就把普通交互页面劫持成翻页。
 *  显式声明方式：容器/根带 data-deck 属性，或页容器 class 含 deck-slide / ba-deck。
 *  向后兼容：经典 .slide/.ba-slide 页容器需 ≥2 个且不含表单控件（input/select/textarea/button）才视为 deck。 */
function isDeckFile(html: string): boolean {
  if (/\bdata-deck\s*=/.test(html)) return true;
  if (/\bclass=["'][^"']*(?:deck-slide|ba-deck)[^"']*["']/i.test(html)) return true;
  const slideCount = (html.match(/\bclass=["'][^"']*\bslide\b[^"']*["']/gi) || []).length;
  if (slideCount >= 2 && !/<(?:input|select|textarea|button)\b/i.test(html)) return true;
  return false;
}

/** 交互性检测：产物是否含真实可交互控件/事件（用于预览角标与静态提示）。
 *  信号：表单控件、canvas、事件监听、状态驱动渲染（state/render）、data-* 交互标记。 */
function detectInteractivity(html: string): boolean {
  if (/<(?:input|select|textarea|button|canvas)\b/i.test(html)) return true;
  if (/\baddEventListener\s*\(|on(?:click|change|input|submit|keydown|mouseover|input)\s*=/i.test(html)) return true;
  if (/\bdata-(?:filter|sort|toggle|theme|tab|view)\b/i.test(html)) return true;
  if (/\bfunction\s+render\s*\(|\b(?:const|let)\s+state\s*=|\bconst\s+DATA\s*=/i.test(html)) return true;
  return false;
}

/** 编辑模式下展开翻页版全部页面为纵向文档流：保留每页自身布局（flex），解除
 *  scroll-snap / 高度裁剪 / transform 偏移，隐藏翻页控件，保证每一页完整可见可编辑。 */
const SLIDE_EDIT_EXPAND_CSS = `
html, body { height: auto !important; overflow: visible !important; }
html { scroll-snap-type: none !important; scroll-behavior: auto !important; }
.slide, .ba-slide, .deck-slide, [data-deck] > section {
  display: flex !important;
  flex-direction: column;
  position: relative !important;
  width: 100% !important;
  height: auto !important;
  min-height: 100vh;
  min-height: 100dvh;
  overflow: visible !important;
  transform: none !important;
  opacity: 1 !important;
  visibility: visible !important;
  box-sizing: border-box;
}
.nav-btn, .slide-dots, .page-label, .ba-nav, .ba-dots, .ba-page,
.nav-dots, .nav-dot, .page-nav, .slide-nav, .deck-nav, .carousel-nav { display: none !important; }
`;

/** 预览模式 slide 视图样式：仅约束页容器尺寸；display 隐藏/显示与 body 滚动裁剪全部由脚本
 *  用 inline style 控制（不用 !important 强制隐藏，否则脚本的 style.display 无法覆盖 → 页面空白）。 */
const PREVIEW_SLIDE_CSS = `
.slide, .ba-slide, .deck-slide, [data-deck] > section { width: 100% !important; height: 100% !important; box-sizing: border-box; }
`;

/** 预览模式 slide 视图脚本：识别 .slide/.ba-slide 页容器（≥2 个启用），一次显示一页；
 *  支持滚轮 / 方向键 / 底部翻页器三种方式切换；页数/当前页通过 postMessage 与 parent 同步；
 *  隐藏文件自带翻页控件避免双重控制。
 *  隐藏用 inline display:none（可覆盖文件普通规则），显示用 style.display='' 恢复文件默认布局。 */
const PREVIEW_SLIDE_JS = `(function(){
  var els=document.querySelectorAll('[data-deck] > section,.slide,.ba-slide,.deck-slide');
  var pages=[];for(var i=0;i<els.length;i++)pages.push(els[i]);
  if(pages.length<2)return;
  document.documentElement.style.overflow='hidden';
  document.body.style.overflow='hidden';
  var kill=document.querySelectorAll('.nav-btn,.slide-dots,.page-label,.ba-nav,.ba-dots,.ba-page,.page-nav,.slide-nav');
  for(var k=0;k<kill.length;k++)kill[k].style.display='none';
  pages.forEach(function(el){el.style.display='none';});
  var cur=0, locked=false;
  function show(idx){
    cur=idx;
    pages.forEach(function(el,j){
      el.style.display=(j===idx)?'':'none';
    });
    try{window.parent.postMessage({type:'ba-preview-slide-page',page:idx},'*');}catch(e){}
  }
  /** 翻页 + 防抖锁定：滚轮惯性/连击时不连翻，外部按钮跳转立即生效 */
  function turn(d){
    if(locked)return;
    var nx=cur+d;
    if(nx<0||nx>=pages.length)return;
    locked=true;
    show(nx);
    setTimeout(function(){locked=false;},420);
  }
  window.addEventListener('message',function(e){
    var d=e.data;if(!d||d.type!=='ba-preview-goto-page')return;
    var idx=parseInt(d.page,10);
    if(isNaN(idx)||idx<0||idx>=pages.length)return;
    locked=false;
    show(idx);
  });
  // 滚轮切换翻页：首页同样参与翻页（向上滚回首页，向下滚到下一页）
  window.addEventListener('wheel',function(e){
    e.preventDefault();
    turn(e.deltaY>0?1:-1);
  },{passive:false});
  // 键盘方向键/空格翻页
  window.addEventListener('keydown',function(e){
    var k=e.key;
    if(k==='ArrowDown'||k==='ArrowRight'||k==='PageDown'||k===' '){e.preventDefault();turn(1);}
    else if(k==='ArrowUp'||k==='ArrowLeft'||k==='PageUp'){e.preventDefault();turn(-1);}
  });
  show(0);
  try{window.parent.postMessage({type:'ba-preview-slide-count',count:pages.length},'*');}catch(e){}
})();`;

/**
 * 编辑模式 slide 展开脚本：识别"页"容器（.slide / .ba-slide / .page / [data-page]，≥2 个启用），
 * 把所有页展开为纵向文档流（解除 deck transform 偏移 / overflow / 高度裁剪 / scroll-snap），
 * 隐藏文件自带翻页控件；面板翻页器只做「滚动定位到目标页」，页数/当前页通过 postMessage 同步。
 * 与 SLIDE_EDIT_EXPAND_CSS 配合，保证每一页完整可见、可检选编辑。
 */
const EDIT_PAGE_NAV_JS = `(function(){
  var root=document.body;if(!root)return;
  var sels=['[data-deck] > section','.slide','.ba-slide','.deck-slide','.page','[data-page]'];
  var pages=null;
  for(var i=0;i<sels.length;i++){
    var els=document.querySelectorAll(sels[i]);
    if(els.length>=2){pages=Array.prototype.slice.call(els);break;}
  }
  if(!pages)return;
  /** 展开元素祖先：解除翻页容器（deck）的 transform 偏移、overflow/高度裁剪，保证页内容完整可见 */
  function expandAncestors(el){
    var anc=el.parentElement;
    while(anc&&anc!==document.documentElement){
      var cs=window.getComputedStyle(anc);
      if(cs.transform!=='none'&&/matrix|translate|scale|rotate/.test(cs.transform)){
        anc.style.transform='none';
      }
      if(cs.display==='none')anc.style.display='block';
      if(cs.overflow==='hidden'||cs.overflowX==='hidden'||cs.overflowY==='hidden'){
        anc.style.overflow='visible';
        anc.style.overflowX='visible';
        anc.style.overflowY='visible';
      }
      if(cs.height==='100vh'||cs.height==='100dvh'||cs.maxHeight==='100vh'){anc.style.height='auto';anc.style.maxHeight='none';}
      anc=anc.parentElement;
    }
  }
  pages.forEach(function(el,idx){
    el.setAttribute('data-ba-page',String(idx+1));
    // 解除该页自身的切换残留（transform 偏移 / 透明 / 隐藏），并展开其祖先容器
    el.style.transform='none';
    el.style.opacity='1';
    el.style.visibility='visible';
    el.style.display='';
    expandAncestors(el);
  });
  document.documentElement.style.height='auto';
  document.documentElement.style.overflow='visible';
  document.documentElement.style.scrollSnapType='none';
  document.body.style.height='auto';
  document.body.style.overflow='visible';
  // 隐藏文件自带的翻页控件（避免干扰编辑）
  var kill=document.querySelectorAll('.nav-btn,.slide-dots,.page-label,.ba-nav,.ba-dots,.ba-page,.nav-dots,.nav-dot,.page-nav,.slide-nav,.deck-nav,.carousel-nav');
  for(var k=0;k<kill.length;k++)kill[k].style.display='none';
  // 翻页器定位：滚动到目标页顶部（所有页保持可见，便于连续编辑）
  window.addEventListener('message',function(e){
    var d=e.data;if(!d||d.type!=='ba-edit-goto-page')return;
    var idx=parseInt(d.page,10);
    if(isNaN(idx)||idx<0||idx>=pages.length)return;
    pages[idx].scrollIntoView({behavior:'smooth',block:'start'});
    window.parent.postMessage({type:'ba-edit-current-page',page:idx},'*');
  });
  window.parent.postMessage({type:'ba-edit-page-count',count:pages.length},'*');
})();`;

/** 将 inspector 脚本注入 HTML（在 </body> 前或末尾追加） */
function injectInspector(html: string): string {
  let out = html;
  // 翻页版文件：编辑时展开全部页面为纵向文档流，保证每一页都可检选编辑
  if (isDeckFile(out)) {
    const styleTag = `<style id="ba-edit-expand-slides">${SLIDE_EDIT_EXPAND_CSS}</style>`;
    if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, styleTag + '</head>');
    else out = styleTag + out;
  }
  // 编辑页展开脚本：解除 deck transform / scroll-snap，翻页器仅滚动定位（无多页结构时脚本自动跳过）
  const script = `<script>${INSPECTOR_SCRIPT}</script><script>${EDIT_PAGE_NAV_JS}</script>`;
  if (out.includes('</body>')) {
    return out.replace('</body>', `${script}</body>`);
  }
  return out + script;
}

/** 预览模式 slide 视图注入：识别翻页结构后注入翻页样式与脚本（无多页结构时脚本自动跳过） */
function injectPreviewSlide(html: string): string {
  let out = html;
  const styleTag = `<style id="ba-preview-slide">${PREVIEW_SLIDE_CSS}</style>`;
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, styleTag + '</head>');
  else out = styleTag + out;
  const script = `<script>${PREVIEW_SLIDE_JS}</script>`;
  if (out.includes('</body>')) {
    return out.replace('</body>', `${script}</body>`);
  }
  return out + script;
}

// ===== 预览交互补丁：让 target=_blank/_top/_parent / window.open / form 提交全部在 iframe 内完成，不打开新面板、不顶掉宿主界面 =====
const PREVIEW_INTERACTION_PATCH = `(function(){
  // 会跳出 iframe 的 target 值集合：_blank/_new 开新窗口、_top/_parent 导航上层窗口（会把整个程序界面顶掉）
  function isTopTarget(t){ return t === '_blank' || t === '_new' || t === '_top' || t === '_parent'; }
  // 危险 href：srcDoc 页面没有自己的 base URL，相对路径会解析到宿主应用 URL——iframe 内一旦导航就加载整个 BobWork 界面（预览变画布）。
  // 若页面注入了 <base href="/api/project-files/...">（项目文件定向代理），相对路径会解析到项目文件，属安全放行。
  // 单文件 HTML 产物（bob-html-artifact 默认形态）：所有 CSS/JS 均内联，没有外部资源依赖；Tab/按钮常见的 href="" / href="#"
  // / onclick 导航必须放行，不能被误判为"相对路径"而拦截。
  function isUnsafeHref(href){
    if(!href || typeof href !== 'string') return false;
    var h = href.trim();
    // 空 href、纯 hash、hash 带 query 都是"当前页"语义，放行
    if(h === '') return false;
    if(h.indexOf('#')===0) return false;
    var hLower = h.toLowerCase();
    if(hLower.indexOf('javascript:')===0) return false;   // js 协议
    if(hLower.indexOf('data:')===0) return false;
    if(hLower.indexOf('http://')===0||hLower.indexOf('https://')===0) return false; // 外部站：iframe 内打开（原界面完成）
    if(hLower.indexOf('//')===0) return false;            // 协议相对外部站
    if(hLower.indexOf('mailto:')===0||hLower.indexOf('tel:')===0) return false;
    try { if (document.querySelector('base[href]')) return false; } catch(_){} // 有 base → 相对路径已定向到项目文件
    return true; // 其余一律视为相对路径 → 会加载宿主应用，必须拦截
  }
  // 1) 所有会跳出 iframe 的 a/form target 改为 _self；动态新增的 a/form 也覆盖
  function patchTargets(root){
    try {
      var links = root.querySelectorAll('a[target="_blank"],a[target="_new"],a[target="_top"],a[target="_parent"]');
      for (var i=0;i<links.length;i++) links[i].setAttribute('target','_self');
      var forms = root.querySelectorAll('form[target="_blank"],form[target="_new"],form[target="_top"],form[target="_parent"]');
      for (var j=0;j<forms.length;j++) forms[j].setAttribute('target','_self');
    } catch(e) {}
  }
  patchTargets(document.documentElement || document);
  // 点击兜底（捕获阶段）：target 降级 _self；只拦截真正不安全的 href（相对路径/空 href 不再一刀切）。
  // Tab/按钮常见用法：<a href="">、<a href="#" onclick="...">、<button onclick="..."> 都必须放行——
  // 这些都是"当前页"语义，真正的交互逻辑在 JS 中，不应被劫持 preventDefault。
  document.addEventListener('click', function(e){
    var el = e.target;
    while (el && el !== document.body) {
      if (el.tagName === 'A') {
        var t = el.getAttribute && el.getAttribute('target');
        if (t && isTopTarget(t)) el.setAttribute('target','_self');
        var href = el.getAttribute && el.getAttribute('href');
        if (href !== null && isUnsafeHref(href)) e.preventDefault();
        break;
      }
      el = el.parentElement;
    }
  }, true);
  // form 提交兜底：target 降级 _self；action 为相对路径或无 action（默认提交到宿主 URL）→ 拦截
  document.addEventListener('submit', function(e){
    var f = e.target;
    if (f && f.tagName === 'FORM') {
      var t = f.getAttribute && f.getAttribute('target');
      if (t && isTopTarget(t)) f.setAttribute('target','_self');
      var act = f.getAttribute && f.getAttribute('action');
      if (act === null || act === '' || isUnsafeHref(act)) e.preventDefault();
    }
  }, true);
  // 2) 拦截 window.open：相对路径直接拒绝；安全 URL 在 iframe 自身打开
  var _origOpen = window.open;
  window.open = function(url, target, features) {
    if (!url || typeof url !== 'string') return null;
    if (isUnsafeHref(url)) return null;
    try {
      // 绝对或相对路径都让 iframe 自己导航
      if (!target || target === '_blank' || target === '_new') {
        window.location.href = url;
        return window;
      }
      if (target === '_self') { window.location.href = url; return window; }
      // 其他有名 target，退化到当前 iframe
      window.location.href = url;
      return window;
    } catch(err) {
      // 回退：调用原生（若 sandbox 拦截则会失败，至少不报错崩溃）
      try { return _origOpen(url, '_self', features || ''); } catch(_){ return null; }
    }
  };
  // 3) 动态元素 MutationObserver：JS 新建 <a target=_blank> 依然被 patch
  try {
    if (typeof MutationObserver !== 'undefined') {
      var mo = new MutationObserver(function(muts){
        for (var k=0;k<muts.length;k++) {
          var m = muts[k];
          if (m.addedNodes && m.addedNodes.length) {
            for (var n=0;n<m.addedNodes.length;n++) {
              var node = m.addedNodes[n];
              if (node && node.nodeType === 1) {
                patchTargets(node);
              }
            }
          }
        }
      });
      mo.observe(document.documentElement || document.body || document, { childList: true, subtree: true });
    }
  } catch(_) {}
  // 4) base target：若页面声明 <base target=_blank/_top/_parent>，覆盖为 _self
  var bases = document.getElementsByTagName('base');
  for (var bi=0;bi<bases.length;bi++){
    var bt = bases[bi].getAttribute('target');
    if (bt && isTopTarget(bt)) bases[bi].setAttribute('target','_self');
  }
})();`;

/** 预览交互补丁注入：把所有会跳新窗口的行为统一改成在 iframe 内完成 */
function injectPreviewInteractionPatch(html: string): string {
  let out = html;
  const script = `<script>${PREVIEW_INTERACTION_PATCH}</script>`;
  if (/<\/head>/i.test(out)) {
    // 放在 </head> 前，保证脚本在页面资源加载之前生效
    return out.replace(/<\/head>/i, script + '</head>');
  }
  if (out.includes('</body>')) {
    return out.replace('</body>', script + '</body>');
  }
  return out + script;
}

/** 注入 <base href>：让 srcDoc 内相对资源（<script src>、<link href>）与相对链接解析到项目文件静态代理。
 *  页面自带 <base> 时尊重原 base，不覆盖。base 标签必须位于交互补丁脚本之前（脚本执行时需能查到 base）。 */
function injectBaseHref(html: string, base: string | null): string {
  if (!base) return html;
  if (/<base[\s>]/i.test(html)) return html;
  const tag = `<base href="${base}">`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, tag + '</head>');
  return tag + html;
}

/** 计算预览 base：项目文件场景（projectId + filePath）→ 指向文件所在目录的 /api/project-files 静态代理。
 *  相对路径因此解析到项目文件而非宿主应用（既是"能加载相对 JS/CSS"的前提，也从根源上杜绝"预览变画布"）。 */
function computePreviewBase(projectId: string | null | undefined, filePath: string | null | undefined): string | null {
  if (!projectId || !filePath) return null;
  const segs = filePath.split('/');
  segs.pop(); // 去掉文件名，保留目录
  const dir = segs.map((s) => encodeURIComponent(s)).join('/');
  return `/api/project-files/${encodeURIComponent(projectId)}${dir ? '/' + dir : ''}/`;
}

// ======================= Types =======================

interface SelectedElement {
  tag: string;
  id: string;
  className: string;
  selector: string;
  outerHTML: string;
  textPreview: string;
}

/** 文字级选中：与元素级并存（面板显示锚元素信息 + chip 显示精确文字摘要） */
interface SelectedTextScope {
  /** 被选中的完整文字（最多 2000 字符），直接作为初始指令或参考 */
  text: string;
  /** 22 字内的短摘要，用于 chip 展示 */
  textShort: string;
  /** 文字所在的锚元素（与 SelectedElement 结构一致），用于 selector/outerHTML 面板 */
  element: SelectedElement;
}

interface EditRecord {
  instruction: string;
  elementSelector?: string;
  beforeHtml: string;
  afterHtml: string;
  timestamp: string;
  /** 批量修改：记录中涉及多个修改点（全文档 AI 编辑时计算）；单点修改时为空 */
  changePoints?: ChangePoint[];
}

/** 单个修改点：before/after 中同一元素（或新增/删除）的前后 HTML */
interface ChangePoint {
  selector: string;
  beforeHtml: string;
  afterHtml: string;
}

/** diff 弹窗目标：一段 HTML 修改的前后对比（单点元素 / 批量修改点 / 整页） */
interface DiffViewTarget {
  beforeHtml: string;
  afterHtml: string;
  scope: string;
  instruction: string;
}

// ======================= Helpers =======================

/** 本地直替：把新文案按比例分配到元素内所有文本节点上（保留 <em>/<b> 等子标签结构，只换文字）。
 *  script/style 内的文本节点跳过；没有文本节点时退化为 textContent 整体写入。 */
function distributeTextAcrossNodes(el: Element, newText: string): void {
  const nodes: Text[] = [];
  const walk = (child: Node) => {
    child.childNodes.forEach((c) => {
      if (c.nodeType === Node.TEXT_NODE) {
        if ((c.textContent || '').trim()) nodes.push(c as Text);
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        const tag = (c as Element).tagName.toUpperCase();
        if (tag !== 'SCRIPT' && tag !== 'STYLE') walk(c);
      }
    });
  };
  walk(el);
  if (nodes.length === 0) {
    el.textContent = newText;
    return;
  }
  const total = nodes.reduce((s, n) => s + (n.textContent || '').length, 0);
  let start = 0;
  nodes.forEach((n, i) => {
    const len = (n.textContent || '').length;
    const isLast = i === nodes.length - 1;
    const take = isLast ? Math.max(0, newText.length - start) : Math.round((len / total) * newText.length);
    n.textContent = newText.slice(start, start + take);
    start += take;
  });
}

/** 从完整 HTML 中提取指定选择器元素的 outerHTML（用于 diff 对比；选择器缺失或元素不存在返回空串） */
function extractElementHtml(html: string, selector?: string): string {
  if (!selector) return '';
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const el = doc.querySelector(selector);
    return el ? el.outerHTML : '';
  } catch {
    return '';
  }
}

interface DiffLine {
  kind: 'same' | 'del' | 'add';
  text: string;
}

/** 逐行 LCS diff：返回 before→after 的行序列（same=不变 / del=删除 / add=新增） */
function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) { out.push({ kind: 'del', text: a[i] }); i++; }
  while (j < m) { out.push({ kind: 'add', text: b[j] }); j++; }
  return out;
}

/** 生成可跨文档匹配的元素 selector（tag + id + class + nth-of-type 链），rootDoc 用于边界判断 */
function buildSelectorFor(el: Element, rootDoc: Document): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== rootDoc.body) {
    let part = cur.tagName.toLowerCase();
    if (cur.id) {
      parts.unshift(`#${cur.id}`);
      break;
    }
    const cn = typeof cur.className === 'string' ? cur.className.trim() : '';
    if (cn) part += '.' + cn.split(/\s+/).filter(Boolean).join('.');
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const sibs = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(' > ');
}

/** 在文档中查找元素（querySelector 失败返回 null） */
function findElementBySelector(doc: Document, selector: string): Element | null {
  try {
    return doc.querySelector(selector);
  } catch {
    return null;
  }
}

/** 批量修改点识别：对比 before/after 两棵 DOM，找出所有发生变化 / 新增 / 删除的元素（去重，上限 20 个） */
function computeChangePoints(beforeHtml: string, afterHtml: string): ChangePoint[] {
  try {
    const beforeDoc = new DOMParser().parseFromString(beforeHtml, 'text/html');
    const afterDoc = new DOMParser().parseFromString(afterHtml, 'text/html');
    const beforeEls = Array.from(beforeDoc.body.querySelectorAll('*'));
    const afterEls = Array.from(afterDoc.body.querySelectorAll('*'));
    const points: ChangePoint[] = [];
    const seen = new Set<string>();
    const pushPoint = (selector: string, beforeOuter: string, afterOuter: string) => {
      if (!selector || seen.has(selector) || beforeOuter === afterOuter) return;
      seen.add(selector);
      points.push({ selector, beforeHtml: beforeOuter, afterHtml: afterOuter });
    };
    for (const el of afterEls) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      const sel = buildSelectorFor(el, afterDoc);
      const beforeMatch = findElementBySelector(beforeDoc, sel);
      if (!beforeMatch) pushPoint(sel, '', el.outerHTML);
      else if (beforeMatch.outerHTML !== el.outerHTML) pushPoint(sel, beforeMatch.outerHTML, el.outerHTML);
    }
    for (const el of beforeEls) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      const sel = buildSelectorFor(el, beforeDoc);
      if (!findElementBySelector(afterDoc, sel)) pushPoint(sel, el.outerHTML, '');
    }
    return points.slice(0, 20);
  } catch {
    return [];
  }
}

// ======================= Component =======================

export function HtmlViewer({
  fileInfo,
  source,
  filePath,
  projectId,
}: ViewerRenderProps) {
  const content = fileInfo.content || '';

  // 编辑模式状态
  const [editMode, setEditMode] = useState(false);
  const [currentHtml, setCurrentHtml] = useState(content);

  // content（文件内容 prop）变化 → 同步编辑态（切换文件/外部重载）。
  // 注意：AI 编辑保存只更新 currentHtml + 写盘（父组件 content 不变），不触发此 effect，
  // 因此退出编辑后预览仍显示编辑后的内容——此前预览用 content 导致"退出恢复原样、重进又变"。
  useEffect(() => {
    setCurrentHtml(content);
  }, [content]);

  // 预览模式 slide 视图：翻页结构（.slide 容器）文件以幻灯片方式逐页浏览；页数/当前页来自 iframe 脚本上报
  const [previewSlide, setPreviewSlide] = useState(false);
  const [previewPageCount, setPreviewPageCount] = useState(0);
  const [previewPageIndex, setPreviewPageIndex] = useState(0);
  // 兜底恢复计数：iframe 被任何途径导航到宿主应用（预览/编辑变画布）时 +1，强制重置 srcDoc 恢复内容
  const [restoreNonce, setRestoreNonce] = useState(0);
  // 兜底检测 + 重置：iframe 已加载非 srcdoc 且同 origin（= 宿主界面）→ 恢复
  const restoreIframeIfNavigated = useCallback(() => {
    try {
      const w = iframeRef.current?.contentWindow;
      if (w && w.location && w.location.href && w.location.href !== 'about:srcdoc') {
        // 项目文件静态代理（相对路径解析后的目标）属合法内容，放行；其余同 origin（宿主应用界面）→ 恢复
        if (!w.location.href.includes('/api/project-files/') && w.location.origin === window.location.origin) {
          setRestoreNonce((k) => k + 1);
        }
      }
    } catch { /* cross-origin：外部站导航，非宿主，放行 */ }
  }, []);

  // 编辑模式页导航：页数（0=无多页结构）+ 当前页
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  // ref 同步当前页：AI 修改 / 撤销重做导致 iframe 重载后，恢复此前所在页
  const currentPageRef = useRef(0);
  useEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);
  // 快速跳页输入框
  const [pageInput, setPageInput] = useState('');

  // 选中元素（元素级：点击元素产生）
  const [selectedElement, setSelectedElement] = useState<SelectedElement | null>(null);
  // 选中文字范围（文字级：拖动选择文字产生），与 selectedElement 并存 —— selectedElement 显示锚元素
  const [selectedText, setSelectedText] = useState<SelectedTextScope | null>(null);

  // 指令输入
  const [instruction, setInstruction] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // AI 流式进度
  const [streamTokens, setStreamTokens] = useState(0);
  const [streamPhase, setStreamPhase] = useState<'connecting' | 'generating' | 'retry' | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // 快速编辑：AI 草稿态（待确认替换） + 瞬时状态提示（本地替换等快速反馈）
  const [aiDraftMode, setAiDraftMode] = useState(false);
  const [quickStatus, setQuickStatus] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const quickStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // AI 模型选择（同 ChatNode 紧凑版）
  const [aiModelId, setAiModelId] = useState<string>(DEFAULT_MODEL_ID);
  const [aiModelMenuOpen, setAiModelMenuOpen] = useState(false);
  const aiModelMenuRef = useRef<HTMLDivElement>(null);
  const [aiProviderConfigs, setAiProviderConfigs] = useState<ProviderConfig[]>([]);
  const [aiChatPool, setAiChatPool] = useState<Array<{ provider: string; modelId: string }>>([]);
  // 面板首次打开/进入编辑模式时加载配置（避免每次组件 mount 都读盘）
  useEffect(() => {
    if (!editMode) return;
    let alive = true;
    const load = async () => {
      try {
        const settings = await loadSettings();
        if (!alive) return;
        setAiProviderConfigs(settings.providers ?? []);
        setAiChatPool(settings.chatModel?.pool ?? []);
      } catch {
        /* ignore */
      }
    };
    load();
    const handler = () => load();
    window.addEventListener('provider-configs-changed', handler);
    return () => {
      alive = false;
      window.removeEventListener('provider-configs-changed', handler);
    };
  }, [editMode]);
  useEffect(() => {
    if (editMode) return;
    setAiModelMenuOpen(false);
  }, [editMode]);
  const aiAvailableModels = useMemo(() => getAvailableModels(aiProviderConfigs), [aiProviderConfigs]);
  const aiRolePoolModels = useMemo(() => {
    const poolIds = new Set(aiChatPool.map((p) => `${p.provider}:${p.modelId}`));
    const seen = new Set<string>();
    const result: AvailableModel[] = [];
    for (const m of aiAvailableModels) {
      if (seen.has(m.modelId)) continue;
      const inPoolSplit = aiChatPool.some((c) => isCustomModel(m.modelId) ? (() => {
        const p = parseCustomModel(m.modelId);
        return p ? p.provider === c.provider && p.modelId === c.modelId : false;
      })() : false);
      if (inPoolSplit || poolIds.has(m.modelId)) {
        seen.add(m.modelId);
        result.push(m);
      }
    }
    return result;
  }, [aiAvailableModels, aiChatPool]);
  // 点模型菜单外关闭
  useEffect(() => {
    if (!aiModelMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!aiModelMenuRef.current?.contains(e.target as Node)) setAiModelMenuOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [aiModelMenuOpen]);

  // 撤销/重做栈
  const [undoStack, setUndoStack] = useState<EditRecord[]>([]);
  const [redoStack, setRedoStack] = useState<EditRecord[]>([]);
  // 历史 diff 弹窗：当前查看修改前后对比的目标（单点或批量修改点）
  const [diffTarget, setDiffTarget] = useState<DiffViewTarget | null>(null);
  // 历史列表中展开的批量修改条目（按序号标记，null=全部收起）
  const [expandedHistoryId, setExpandedHistoryId] = useState<number | null>(null);

  // 保存状态
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // iframe ref（用于 postMessage 来源校验）
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // 是否可保存：项目文件（source=project）与节点模式文件（source 被兜底为 local 但 filePath+projectId 有效）
  // 都通过 /api/projects write_file 写回项目目录；纯本地文件（无 projectId）不支持写回 → 仅预览。
  const canSave = !!filePath && !!projectId;

  // ---- 弹窗面板：位置（默认预览面板左侧）+ 折叠 + 拖拽 ----
  const containerRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState({ x: 12, y: 12 });
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  /** 标题栏拖拽自由移动浮窗（fixed 屏幕坐标，clamp 在窗口内避免拖丢） */
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: panelPos.x, origY: panelPos.y };
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const maxX = Math.max(0, window.innerWidth - 40);
      const maxY = Math.max(0, window.innerHeight - 40);
      const x = Math.min(Math.max(0, d.origX + ev.clientX - d.startX), maxX);
      const y = Math.min(Math.max(0, d.origY + ev.clientY - d.startY), maxY);
      setPanelPos({ x, y });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [panelPos]);

  // ---- 历史修改：默认折叠 ----
  const [historyExpanded, setHistoryExpanded] = useState(false);

  // 进入/退出编辑模式时重置状态
  const enterEditMode = useCallback(() => {
    // 不重置 currentHtml：编辑后退出再进入应保留上次编辑结果（磁盘已保存，
    // 重置为 content 会丢修改）；content 变化已由上方同步 effect 处理。
    setEditMode(true);
    setSelectedElement(null);
    setSelectedText(null);
    setInstruction('');
    setError(null);
    setAiDraftMode(false);
    setQuickStatus(null);
    setUndoStack([]);
    setRedoStack([]);
    setSaveStatus('idle');
    setPanelCollapsed(false);
    setHistoryExpanded(false);
    setPageCount(0);
    setCurrentPage(0);
    setPageInput('');
  }, [content]);

  const exitEditMode = useCallback(() => {
    setEditMode(false);
    setSelectedElement(null);
    setSelectedText(null);
    setInstruction('');
    setError(null);
    setAiDraftMode(false);
    setQuickStatus(null);
  }, []);

  // 瞬时状态提示（本地替换 / 草稿就绪 / 保存失败等快速反馈，2.4s 后自动消失）
  const flashStatus = useCallback((type: 'ok' | 'err', text: string) => {
    setQuickStatus({ type, text });
    if (quickStatusTimerRef.current) clearTimeout(quickStatusTimerRef.current);
    quickStatusTimerRef.current = setTimeout(() => setQuickStatus(null), 2400);
  }, []);

  // 自动保存（防抖 300ms）
  const autoSave = useCallback((html: string) => {
    if (!canSave) {
      // 无法保存（无项目上下文）时给可见提示，避免"改了但没保存"静默发生
      flashStatus('err', 'Auto-save unavailable: file is not linked to a project');
      return;
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus('saving');
    saveTimerRef.current = setTimeout(async () => {
      try {
        const resp = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'write_file', project_id: projectId, file_path: filePath, content: html }),
        });
        if (resp.ok) setSaveStatus('saved');
        else {
          setSaveStatus('idle');
          flashStatus('err', `Auto-save failed: ${resp.status}`);
        }
      } catch (e) {
        setSaveStatus('idle');
        flashStatus('err', `Auto-save failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, 300);
  }, [canSave, projectId, filePath, flashStatus]);

  /** 吸附面板到 iframe 内被点击区块的下方（屏幕坐标）。
   *  inspector 上报区块左下角（相对 iframe 视口），换算为 fixed 面板位置并做边界 clamp，
   *  确保面板不超出 iframe 可视区（超出时靠右/靠下贴边）。 */
  const attachPanelToElement = useCallback((pos: { x: number; y: number }) => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const iframeRect = iframe.getBoundingClientRect();
    const PANEL_W = 300;
    const GAP = 8;
    let x = iframeRect.left + pos.x;
    let y = iframeRect.top + pos.y + GAP;
    // 面板宽 300：右边界 clamp（不超出 iframe 右缘）
    if (x + PANEL_W > iframeRect.right - GAP) x = iframeRect.right - GAP - PANEL_W;
    if (x < iframeRect.left + GAP) x = iframeRect.left + GAP;
    // 顶部超出 iframe 上缘 → 改为贴区块上方（避免面板不可见）
    if (y < iframeRect.top + GAP) y = Math.max(iframeRect.top + GAP, iframeRect.top + pos.y - GAP - 200);
    setPanelPos({ x, y });
  }, []);

  // 监听 iframe postMessage
  useEffect(() => {
    if (!editMode) return;
    const handler = (e: MessageEvent) => {
      // 校验来源：必须是我们的 iframe
      if (iframeRef.current?.contentWindow !== e.source) return;
      const data = e.data;
      if (!data || typeof data !== 'object') return;

      if (data.type === 'element-selected' && data.element) {
        // 元素级点击选中：清除文字级 chip（元素点击与文字拖动互斥）
        setSelectedElement(data.element as SelectedElement);
        setSelectedText(null);
        // 吸附：面板定位到被点击区块的下方（inspector 上报区块左下角）
        if (data.pos && typeof data.pos.x === 'number' && typeof data.pos.y === 'number') {
          attachPanelToElement({ x: data.pos.x, y: data.pos.y });
        }
      } else if (data.type === 'element-deselected') {
        setSelectedElement(null);
        setSelectedText(null);
      } else if (data.type === 'html-text-selected' && data.text) {
        // 文字级选中：保留锚元素在面板，新增 chip 显示具体文字范围
        if (data.element) setSelectedElement(data.element as SelectedElement);
        setSelectedText({
          text: data.text,
          textShort: data.textShort || (data.text.length > 22 ? data.text.slice(0, 22) + '…' : data.text),
          element: (data.element as SelectedElement) || {
            tag: '', id: '', className: '', selector: '', outerHTML: '', textPreview: '',
          },
        });
        // 初始指令填入选中的完整文字（用户可修改）
        setInstruction(data.text);
      } else if (data.type === 'ba-edit-page-count' && typeof data.count === 'number') {
        setPageCount(data.count);
        setCurrentPage(0);
      } else if (data.type === 'ba-edit-current-page' && typeof data.page === 'number') {
        setCurrentPage(data.page);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [editMode, attachPanelToElement]);

  // 预览模式 slide 视图：接收 iframe 内翻页脚本上报的页数/当前页
  useEffect(() => {
    if (!previewSlide) return;
    const handler = (e: MessageEvent) => {
      if (iframeRef.current?.contentWindow !== e.source) return;
      const data = e.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'ba-preview-slide-count' && typeof data.count === 'number') {
        setPreviewPageCount(data.count);
        setPreviewPageIndex(0);
      } else if (data.type === 'ba-preview-slide-page' && typeof data.page === 'number') {
        setPreviewPageIndex(data.page);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [previewSlide]);

  // 进入编辑模式：弹窗定位到预览面板左侧边框外部（屏幕坐标，fixed 定位）。
  // Portal 渲染到 body，可自由拖拽；左侧无空间时回退到预览面板左侧内部。
  useEffect(() => {
    if (!editMode) return;
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const PANEL_W = 300;
    const GAP = 12;
    let x = r.left - PANEL_W - GAP;
    if (x < 8) x = r.left + GAP;
    const y = Math.max(8, r.top);
    setPanelPos({ x, y });
  }, [editMode]);

  // 取消当前 AI 编辑请求
  const cancelEdit = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

  /** 清除文字级选中（点击 chip × / 操作成功 / 撤销重做等场景自动触发）：通知 iframe 移除黄色覆盖，同时清本地状态 */
  const clearTextSelection = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'ba-clear-text-highlight' }, '*');
    setSelectedText(null);
  }, []);

  // 本地替换：style='preserve' 按文本节点分配新文案（保留子标签）；style='plain' 整体替换为纯文字
  const applyLocalReplace = useCallback((rawText: string, style: 'preserve' | 'plain') => {
    if (!selectedElement) return;
    const text = rawText.trim();
    if (!text) {
      flashStatus('err', 'Type replacement text first');
      return;
    }
    let afterHtml: string;
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(currentHtml, 'text/html');
      const targetEl = doc.querySelector(selectedElement.selector);
      if (!targetEl) {
        flashStatus('err', 'Element not found in document');
        return;
      }
      if (style === 'plain') {
        targetEl.textContent = text;
      } else {
        distributeTextAcrossNodes(targetEl, text);
      }
      afterHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
    } catch (e) {
      flashStatus('err', e instanceof Error ? e.message : String(e));
      return;
    }
    const record: EditRecord = {
      instruction: text,
      elementSelector: selectedElement.selector,
      beforeHtml: currentHtml,
      afterHtml,
      timestamp: new Date().toISOString(),
    };
    setUndoStack(prev => [...prev, record]);
    setRedoStack([]);
    setCurrentHtml(afterHtml);
    setAiDraftMode(false);
    setSelectedElement(null);
    clearTextSelection();
    setInstruction('');
    setQuickStatus(null);
    autoSave(afterHtml);
  }, [selectedElement, currentHtml, flashStatus, autoSave, clearTextSelection]);

  // AI 优化：请求 text 模式生成纯文字草稿 → 回填输入框（可再编辑）→ 按钮切换为确认替换
  const requestAiOptimize = useCallback(async () => {
    if (!selectedElement) return;
    if (aiDraftMode) {
      applyLocalReplace(instruction, 'plain');
      return;
    }
    if (!instruction.trim() || isProcessing) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const uiTimeoutT = setTimeout(() => controller.abort(new Error('Timeout after 90s')), 90_000);

    setIsProcessing(true);
    setError(null);
    setStreamTokens(0);
    setStreamPhase('connecting');

    try {
      const resp = await fetch('/api/ai-edit/html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: currentHtml,
          instruction: instruction.trim(),
          mode: 'text',
          modelId: aiModelId,
          element: {
            selector: selectedElement.selector,
            outerHTML: selectedElement.outerHTML,
          },
        }),
        signal: controller.signal,
        cache: 'no-store',
      });

      if (!resp.ok && !resp.body) {
        const txt = await resp.text().catch(() => '');
        throw new Error(txt || `HTTP ${resp.status}`);
      }

      let doneData: { success: boolean; html?: string; error?: string } | null = null;
      let lastErr: string | null = null;

      await readSSE(resp, (event, raw) => {
        if (event === 'meta') {
          setStreamPhase('generating');
          return;
        }
        if (event === 'token') {
          setStreamTokens((n) => n + 1);
          return;
        }
        if (event === 'retry') {
          setStreamPhase('retry');
          return;
        }
        if (event === 'error') {
          lastErr = raw;
          return;
        }
        if (event === 'done') {
          try { doneData = JSON.parse(raw); } catch { doneData = null; }
        }
      });

      if (!doneData) throw new Error(lastErr || 'Stream ended without result');
      const done = doneData as { success: boolean; html?: string; error?: string };
      if (!done.success) {
        setError(done.error || lastErr || 'AI edit failed');
        return;
      }
      const draft = (done.html || '').trim();
      if (!draft) {
        setError('AI returned empty draft');
        return;
      }
      setInstruction(draft);
      setAiDraftMode(true);
      flashStatus('ok', 'Draft ready · edit freely, then Confirm');
    } catch (e) {
      const msg = e instanceof Error ? (e.name === 'AbortError' ? 'Cancelled' : e.message) : String(e);
      setError(msg);
    } finally {
      clearTimeout(uiTimeoutT);
      setIsProcessing(false);
      setStreamPhase(null);
      setStreamTokens(0);
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
    }
    // readSSE 为组件内函数，与 applyInstruction 保持一致的依赖风格
  }, [selectedElement, instruction, isProcessing, currentHtml, aiDraftMode, applyLocalReplace, flashStatus, aiModelId]);

  /** SSE 解析：从 ReadableStream 逐行读 SSE，回调 (eventName, jsonPayload | rawString) */
  async function readSSE(
    resp: Response,
    onEvent: (event: string, data: string) => void,
  ): Promise<void> {
    if (!resp.body) throw new Error('No response body');
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let eventLine = '';
    const flushEvent = () => {
      // buffer 里包含 data 行，按 SSE 规范：空行分隔事件
    };
    void flushEvent;
    let dataLines: string[] = [];
    const push = () => {
      const dataStr = dataLines.join('\n');
      if (eventLine || dataStr) {
        onEvent(eventLine || 'message', dataStr);
      }
      eventLine = '';
      dataLines = [];
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      // SSE 以 \n\n（空行）作为事件分隔符
      // eslint-disable-next-line no-cond-assign
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const eventBlock = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = eventBlock.split('\n');
        for (const line of lines) {
          if (line.startsWith(':')) continue; // comment
          if (line.startsWith('event:')) eventLine = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        push();
      }
    }
    // flush tail
    if (buffer) {
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) eventLine = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      push();
    }
  }

  // 应用 AI 修改（SSE 流式 + 90s 前端超时 + 可取消）
  const applyInstruction = useCallback(async () => {
    if (!instruction.trim() || isProcessing) return;

    // 前端 UI 层 90 秒超时保护
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const uiTimeoutMs = 90_000;
    const uiTimeoutT = setTimeout(() => controller.abort(new Error(`Timeout after ${uiTimeoutMs / 1000}s`)), uiTimeoutMs);

    setIsProcessing(true);
    setError(null);
    setStreamTokens(0);
    setStreamPhase('connecting');

    try {
      const isElementMode = !!selectedElement;
      const resp = await fetch('/api/ai-edit/html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: currentHtml,
          instruction: instruction.trim(),
          mode: isElementMode ? 'element' : 'document',
          modelId: aiModelId,
          element: isElementMode ? {
            selector: selectedElement!.selector,
            outerHTML: selectedElement!.outerHTML,
          } : undefined,
        }),
        signal: controller.signal,
        // SSE：禁用缓存，保持长连接
        cache: 'no-store',
      });

      if (!resp.ok && !resp.body) {
        const txt = await resp.text().catch(() => '');
        throw new Error(txt || `HTTP ${resp.status}`);
      }

      // —— 流式消费 SSE，最后收集 event:done 里的完整 JSON 结果 ——
      let doneData: { success: boolean; html?: string; error?: string; model?: string; mode?: 'document' | 'element' } | null = null;
      let lastErr: string | null = null;

      await readSSE(resp, (event, raw) => {
        if (event === 'meta') {
          setStreamPhase('generating');
          return;
        }
        if (event === 'token') {
          try {
            const parsed = JSON.parse(raw) as { t?: string };
            if (parsed?.t) setStreamTokens((n) => n + 1);
          } catch {
            setStreamTokens((n) => n + 1);
          }
          return;
        }
        if (event === 'retry') {
          setStreamPhase('retry');
          return;
        }
        if (event === 'error') {
          lastErr = raw;
          return;
        }
        if (event === 'done') {
          try { doneData = JSON.parse(raw); } catch { doneData = null; }
        }
      });

      if (!doneData) throw new Error(lastErr || 'Stream ended without result');

      // 闭包内赋值的 let 变量会被 TS 收窄为 never，显式断言后使用
      const done = doneData as { success: boolean; html?: string; error?: string; model?: string; mode?: 'document' | 'element' };
      if (!done.success) {
        setError(done.error || lastErr || 'AI edit failed');
        return;
      }

      let newHtml = (done.html || '') as string;

      // 元素级模式：在完整 HTML 中替换选中元素
      if (isElementMode) {
        const newElementHtml = newHtml;
        try {
          const parser = new DOMParser();
          const doc = parser.parseFromString(currentHtml, 'text/html');
          const targetEl = doc.querySelector(selectedElement!.selector);
          if (targetEl && newElementHtml) {
            // 防御：模型误返回完整文档 / 错误层级元素时拒绝替换（否则整页会被嵌进被选元素导致结构崩塌）
            const trimmedOut = newElementHtml.trim();
            if (/^<!doctype\s+/i.test(trimmedOut) || /^<(html|head|body)[\s>]/i.test(trimmedOut)) {
              setError('AI returned the whole document instead of the selected element — no changes applied. Please retry.');
              return;
            }
            const tempDiv = doc.createElement('div');
            tempDiv.innerHTML = newElementHtml;
            const newEl = tempDiv.firstElementChild;
            if (newEl) {
              if (newEl.tagName.toLowerCase() !== targetEl.tagName.toLowerCase()) {
                setError('AI returned a different element than the one selected — no changes applied. Please retry.');
                return;
              }
              // 防御：AI 返回"同标签但内容越界"——把整页/整块结构塞进被选元素（表现为"整体变成一段文字"）。
              // 1) 结构越界：目标不是 slide 容器，但新元素含 slide 专属结构 → 模型返回了整页
              const slideStructSel = '[data-layout], .slide-content, .texture-overlay, .chrome, .kicker, .h-hero, .foot';
              const targetHasSlideStruct = !!targetEl.querySelector(slideStructSel);
              const newHasSlideStruct = !!newEl.querySelector(slideStructSel);
              if (!targetHasSlideStruct && newHasSlideStruct) {
                setError('AI returned a whole slide instead of the selected element — no changes applied. Please retry.');
                return;
              }
              // 2) 文本规模暴增：新元素文本远超目标元素 → 模型越界重写（不是局部修改）
              const oldLen = (targetEl.textContent || '').trim().length;
              const newLen = (newEl.textContent || '').trim().length;
              if (oldLen > 0 && newLen > oldLen * 6 && newLen > 1200) {
                setError('AI rewrote far more content than the selected element — no changes applied. Please retry or select a smaller element.');
                return;
              }
              targetEl.replaceWith(newEl);
              newHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
            }
          }
        } catch {
          const idx = currentHtml.indexOf(selectedElement!.outerHTML.slice(0, 200));
          if (idx >= 0) {
            newHtml = currentHtml.slice(0, idx) + newElementHtml + currentHtml.slice(idx + selectedElement!.outerHTML.slice(0, 200).length);
          } else {
            newHtml = currentHtml;
          }
        }
      }

      // 兜底防御：新 HTML 为空 / 丢失文档骨架 → 拒绝写入（否则编辑区白屏 + autoSave 写坏原文件）
      // 参考后端同款校验；对未完成骨架的片段仅元素级模式允许（它会被替换进完整文档）
      const trimmed = (newHtml || '').trim();
      const hasSkeleton = isElementMode || (
        (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) &&
        trimmed.endsWith('</html>')
      );
      if (!hasSkeleton) {
        setError('AI 返回的 HTML 为空或缺少完整文档结构，已放弃本次修改，原内容保持不变。请重试。');
        return;
      }

      const record: EditRecord = {
        instruction: instruction.trim(),
        elementSelector: selectedElement?.selector,
        beforeHtml: currentHtml,
        afterHtml: newHtml,
        changePoints: isElementMode ? undefined : computeChangePoints(currentHtml, newHtml),
        timestamp: new Date().toISOString(),
      };
      setUndoStack(prev => [...prev, record]);
      setRedoStack([]);
      setCurrentHtml(newHtml);
      setSelectedElement(null);
      clearTextSelection();
      setInstruction('');
      setAiDraftMode(false);
      setQuickStatus(null);
      autoSave(newHtml);
    } catch (e) {
      const msg = e instanceof Error ? (e.name === 'AbortError' ? 'Cancelled' : e.message) : String(e);
      setError(msg);
    } finally {
      clearTimeout(uiTimeoutT);
      setIsProcessing(false);
      setStreamPhase(null);
      setStreamTokens(0);
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
    }
  }, [instruction, isProcessing, selectedElement, currentHtml, autoSave, clearTextSelection, aiModelId]);

  // 撤销
  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) return;
    const last = undoStack[undoStack.length - 1];
    setCurrentHtml(last.beforeHtml);
    setUndoStack(prev => prev.slice(0, -1));
    setRedoStack(prev => [...prev, last]);
    setSelectedElement(null);
    clearTextSelection();
    setAiDraftMode(false);
    autoSave(last.beforeHtml);
  }, [undoStack, autoSave, clearTextSelection]);

  // 重做
  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setCurrentHtml(next.afterHtml);
    setRedoStack(prev => prev.slice(0, -1));
    setUndoStack(prev => [...prev, next]);
    setSelectedElement(null);
    clearTextSelection();
    setAiDraftMode(false);
    autoSave(next.afterHtml);
  }, [redoStack, autoSave, clearTextSelection]);

  // 历史定位：让预览区滚动到修改处并高亮该元素
  const handleLocateSelector = useCallback((selector: string) => {
    if (!selector) return;
    iframeRef.current?.contentWindow?.postMessage(
      { type: 'ba-highlight-element', selector },
      '*',
    );
  }, []);

  // 打开 diff：单点记录（元素级或全文档整页）
  const openDiff = useCallback((r: EditRecord) => {
    const before = r.elementSelector ? extractElementHtml(r.beforeHtml, r.elementSelector) : r.beforeHtml;
    const after = r.elementSelector ? extractElementHtml(r.afterHtml, r.elementSelector) : r.afterHtml;
    setDiffTarget({ beforeHtml: before, afterHtml: after, scope: r.elementSelector || 'Whole document', instruction: r.instruction });
  }, []);

  // 打开 diff：批量修改中的单个修改点
  const openDiffPoint = useCallback((r: EditRecord, cp: ChangePoint) => {
    setDiffTarget({ beforeHtml: cp.beforeHtml, afterHtml: cp.afterHtml, scope: cp.selector, instruction: r.instruction });
  }, []);

  // 跳转到指定页（编辑模式翻页器）：通知 iframe 滚动定位 + 高亮
  const gotoPage = useCallback((page: number) => {
    const iframe = iframeRef.current;
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage({ type: 'ba-edit-goto-page', page }, '*');
    setCurrentPage(page);
  }, []);

  // 预览模式 slide 视图：跳转到指定页（通知 iframe 内脚本切换显示）
  const gotoPreviewSlide = useCallback((page: number) => {
    const iframe = iframeRef.current;
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage({ type: 'ba-preview-goto-page', page }, '*');
    setPreviewPageIndex(page);
  }, []);

  // 预览模式 slide 视图：开启/关闭（开启时重置页状态，等待 iframe 脚本上报真实页数）
  const togglePreviewSlide = useCallback(() => {
    setPreviewSlide((v) => {
      if (!v) {
        setPreviewPageCount(0);
        setPreviewPageIndex(0);
      }
      return !v;
    });
  }, []);

  // 打开到系统默认浏览器：HTML 内容写入临时文件后交给系统默认程序（浏览器）打开
  const handleOpenInBrowser = useCallback(async () => {
    if (!isDesktop()) return;
    const r = await desktop.openHtml(currentHtml, fileInfo.name);
    if (!r.success) {
      setError(r.error || 'Failed to open in browser');
    }
  }, [currentHtml, fileInfo.name]);

  // ======================= Render =======================

  if (!currentHtml.trim()) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm" style={{ color: 'var(--ink-muted)' }}>
        Empty file
      </div>
    );
  }

  // 预览模式
  if (!editMode) {
    // 预览用 currentHtml（编辑态）而非 content（prop）：AI 编辑确认后退出编辑器，
    // 预览立即显示修改结果，不再"恢复原样"；磁盘已由 autoSave 持久化
    const isSlideFile = isDeckFile(currentHtml);
    const isInteractive = detectInteractivity(currentHtml);
    const baseDoc = previewSlide && isSlideFile ? injectPreviewSlide(currentHtml) : currentHtml;
    // base 注入（项目文件静态代理）：相对资源/链接解析到项目文件，既修复交互失效也从根源杜绝"预览变画布"
    const baseHref = computePreviewBase(projectId, filePath);
    // restoreNonce 变化 → srcDoc 变化 → iframe 重载恢复预览内容（兜底"预览变画布"）
    const previewSrcDoc = injectPreviewInteractionPatch(injectBaseHref(baseDoc, baseHref)) + (restoreNonce ? `<!--ba-restore:${restoreNonce}-->` : '');
    return (
      <div className="relative h-full overflow-hidden" style={{ backgroundColor: 'color-mix(in oklab, var(--ink) 6%, transparent)' }}>
        <iframe
          ref={iframeRef}
          title={`Preview: ${fileInfo.name}`}
          srcDoc={previewSrcDoc}
          sandbox="allow-scripts allow-same-origin allow-modals allow-forms"
          className="h-full w-full border-0"
          style={{ backgroundColor: 'var(--paper)' }}
          onLoad={restoreIframeIfNavigated}
        />
        {/* 预览操作按钮：交互性角标 + Slide 视图切换（翻页结构文件）+ AI 编辑（仅图标，提示英文） */}
        <div className="absolute top-3 right-3 flex items-center gap-1.5">
          {/* 交互性角标：检测到可交互控件/事件显示 Interactive，纯静态显示 Static */}
          <span
            className="pointer-events-none hidden items-center gap-1 rounded-full px-2 py-1 text-11 font-semibold sm:flex"
            style={{
              backgroundColor: isInteractive ? 'color-mix(in oklab, var(--success) 14%, transparent)' : 'color-mix(in oklab, var(--ink-muted) 12%, transparent)',
              color: isInteractive ? 'var(--success)' : 'var(--ink-muted)',
              boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
            }}
            title={isInteractive ? 'This page has interactive controls (filters, charts, toggles, …)' : 'This page appears to be static content'}
          >
            {isInteractive ? 'Interactive' : 'Static'}
          </span>
          {isSlideFile && (
            <button
              onClick={togglePreviewSlide}
              className="flex items-center justify-center rounded-md px-1.5 py-1.5 transition-all hover:scale-105"
              style={{
                backgroundColor: previewSlide ? 'var(--paper-hover)' : 'var(--paper)',
                color: previewSlide ? 'var(--primary)' : 'var(--ink-muted)',
                border: '1px solid var(--line)',
                boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
              }}
              title={previewSlide ? 'Exit Slide view, back to full-page scroll' : 'Browse page by page (Slide view)'}
            >
              <BookOpen className="h-3 w-3" />
            </button>
          )}
          {isDesktop() && (
            <button
              onClick={handleOpenInBrowser}
              className="flex items-center justify-center rounded-md px-1.5 py-1.5 transition-all hover:scale-105"
              style={{
                backgroundColor: 'var(--paper)',
                color: 'var(--ink-muted)',
                border: '1px solid var(--line)',
                boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
              }}
              title="Open in system default browser"
            >
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
          <button
            onClick={enterEditMode}
            className="flex items-center justify-center rounded-md px-1.5 py-1.5 transition-all hover:scale-105"
            style={{
              backgroundColor: 'var(--primary)',
              color: 'var(--primary-foreground)',
              boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
            }}
            title="AI Edit"
          >
            <Sparkles className="h-3 w-3" />
          </button>
        </div>
        {/* Slide 视图翻页控制条（底部居中） */}
        {previewSlide && isSlideFile && previewPageCount > 0 && (
          <div
            className="absolute bottom-3 left-1/2 flex items-center gap-2 -translate-x-1/2 rounded-lg px-3 py-1.5"
            style={{
              backgroundColor: 'var(--paper)',
              border: '1px solid var(--line)',
              boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
              zIndex: 50,
            }}
          >
            <button
              onClick={() => gotoPreviewSlide(previewPageIndex - 1)}
              disabled={previewPageIndex === 0}
              className="shrink-0 rounded px-2 text-sm leading-6 disabled:opacity-30 transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink-muted)' }}
              title="Previous page"
            >‹</button>
            <span className="text-xs tabular-nums" style={{ color: 'var(--ink-muted)' }}>
              {previewPageIndex + 1} / {previewPageCount}
            </span>
            <button
              onClick={() => gotoPreviewSlide(previewPageIndex + 1)}
              disabled={previewPageIndex >= previewPageCount - 1}
              className="shrink-0 rounded px-2 text-sm leading-6 disabled:opacity-30 transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink-muted)' }}
              title="Next page"
            >›</button>
          </div>
        )}
      </div>
    );
  }

  // 编辑模式：iframe 全屏 + 弹窗面板（Portal 到 body，位于预览面板左侧边框外部，可自由拖拽）
  const baseHref = computePreviewBase(projectId, filePath);
  const srcDoc = injectBaseHref(injectInspector(currentHtml), baseHref) + (restoreNonce ? `<!--ba-restore:${restoreNonce}-->` : '');

  return (
    <>
    <div ref={containerRef} className="relative h-full overflow-hidden" style={{ backgroundColor: 'color-mix(in oklab, var(--ink) 6%, transparent)' }}>
      {/* 全屏 iframe（注入 inspector，支持元素检选；严格分页一次显示一页） */}
      <iframe
        ref={iframeRef}
        title={`Edit: ${fileInfo.name}`}
        srcDoc={srcDoc}
        sandbox="allow-scripts allow-same-origin"
        className="absolute inset-0 h-full w-full border-0"
        style={{ backgroundColor: 'var(--paper)' }}
        onLoad={() => {
          // 兜底：编辑区被 JS 相对路径导航到宿主应用 → 重置恢复（不再执行翻页定位）
          restoreIframeIfNavigated();
          const p = currentPageRef.current;
          if (p > 0 && iframeRef.current?.contentWindow) {
            iframeRef.current.contentWindow.postMessage({ type: 'ba-edit-goto-page', page: p }, '*');
          }
        }}
      />

      {/* 退出编辑按钮（右上角，始终可见，仅图标） */}
      <button
        onClick={exitEditMode}
        className="absolute top-3 right-3 flex items-center justify-center rounded-md px-1.5 py-1.5 transition-colors"
        style={{
          backgroundColor: 'var(--paper)',
          color: 'var(--ink-muted)',
          border: '1px solid var(--line)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
          zIndex: 60,
        }}
        title="Exit edit mode"
      >
        <X className="h-3 w-3" />
      </button>

    </div>
    {createPortal(
      <div
        className="fixed flex flex-col"
        style={{
          left: panelPos.x,
          top: panelPos.y,
          width: 300,
          zIndex: 9999,
          borderRadius: 10,
          backgroundColor: 'var(--paper)',
          border: '1px solid var(--line)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          overflow: 'hidden',
        }}
      >
        {/* 标题栏：拖拽把手 + 折叠 + 关闭 */}
        <div
          onMouseDown={startDrag}
          className="flex items-center gap-2 px-3 py-2 select-none"
          style={{
            cursor: 'grab',
            borderBottom: '1px solid var(--line-soft)',
            backgroundColor: 'var(--paper-hover)',
            borderTopLeftRadius: 10,
            borderTopRightRadius: 10,
          }}
        >
          <Sparkles className="h-4 w-4 shrink-0" style={{ color: 'var(--primary)' }} />
          <span className="text-sm font-semibold truncate" style={{ color: 'var(--ink)' }}>AI HTML Editor</span>
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <button
              onClick={(e) => { e.stopPropagation(); setPanelCollapsed((v) => !v); }}
              className="rounded p-1 transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink-muted)' }}
              title={panelCollapsed ? 'Expand panel' : 'Collapse panel'}
            >
              {panelCollapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); exitEditMode(); }}
              className="rounded p-1 transition-colors hover:bg-[var(--paper-hover)]"
              style={{ color: 'var(--ink-muted)' }}
              title="Exit edit mode"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* 面板内容（折叠时隐藏） */}
        {!panelCollapsed && (
          <div className="flex max-h-[60vh] flex-col overflow-y-auto ai-canvas-scroll">
            {/* 编辑页导航（翻页器）：识别到多页结构（.slide/.page 等）时显示，可逐页跳转修改 */}
            {pageCount > 0 && (
              <div className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--line-soft)', backgroundColor: 'var(--info-soft)' }}>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <BookOpen className="h-3 w-3 shrink-0" style={{ color: 'var(--primary)' }} />
                  <span className="text-xs font-medium" style={{ color: 'var(--ink)' }}>Pages</span>
                  <span className="ml-auto text-xs tabular-nums" style={{ color: 'var(--ink-muted)' }}>
                    {currentPage + 1} / {pageCount}
                  </span>
                </div>
                {/* 窗口式分页：页数≤7 全显示；>7 只显示首末页 + 当前页±1 窗口 + 省略号 */}
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => gotoPage(Math.max(0, currentPage - 1))}
                    disabled={currentPage === 0}
                    className="shrink-0 rounded px-1.5 text-sm leading-6 disabled:opacity-30"
                    style={{ color: 'var(--ink-muted)', backgroundColor: 'var(--paper-hover)' }}
                    title="Previous page"
                  >‹</button>
                  <div className="flex flex-1 items-center justify-center gap-0.5 py-0.5" style={{ minWidth: 0 }}>
                    {(() => {
                      const items: (number | 'ellipsis')[] = [];
                      if (pageCount <= 7) {
                        for (let i = 0; i < pageCount; i++) items.push(i);
                      } else {
                        items.push(0);
                        const winStart = Math.max(1, currentPage - 1);
                        const winEnd = Math.min(pageCount - 2, currentPage + 1);
                        if (winStart > 1) items.push('ellipsis');
                        for (let i = winStart; i <= winEnd; i++) items.push(i);
                        if (winEnd < pageCount - 2) items.push('ellipsis');
                        items.push(pageCount - 1);
                      }
                      return items.map((item, idx) =>
                        item === 'ellipsis' ? (
                          <span key={`e${idx}`} className="shrink-0 px-0.5 text-xs leading-5" style={{ color: 'var(--ink-faint)' }}>…</span>
                        ) : (
                          <button
                            key={item}
                            onClick={() => gotoPage(item)}
                            className="shrink-0 rounded px-1.5 text-xs leading-5 transition-colors"
                            style={{
                              backgroundColor: item === currentPage ? 'var(--primary)' : 'var(--paper-hover)',
                              color: item === currentPage ? 'var(--primary-foreground)' : 'var(--ink-muted)',
                            }}
                            title={`Go to page ${item + 1}`}
                          >{item + 1}</button>
                        )
                      );
                    })()}
                  </div>
                  <button
                    onClick={() => gotoPage(Math.min(pageCount - 1, currentPage + 1))}
                    disabled={currentPage >= pageCount - 1}
                    className="shrink-0 rounded px-1.5 text-sm leading-6 disabled:opacity-30"
                    style={{ color: 'var(--ink-muted)', backgroundColor: 'var(--paper-hover)' }}
                    title="Next page"
                  >›</button>
                </div>
                {/* 页数多时显示快速跳转行：首页/末页按钮 + 页码输入框 */}
                {pageCount > 7 && (
                  <div className="mt-1.5 flex items-center gap-1">
                    <button
                      onClick={() => gotoPage(0)}
                      disabled={currentPage === 0}
                      className="shrink-0 rounded px-1.5 text-xs leading-5 disabled:opacity-30 transition-colors hover:bg-[var(--paper-hover)]"
                      style={{ color: 'var(--ink-muted)', backgroundColor: 'var(--paper-hover)' }}
                      title="Go to first page"
                    >First</button>
                    <button
                      onClick={() => gotoPage(pageCount - 1)}
                      disabled={currentPage >= pageCount - 1}
                      className="shrink-0 rounded px-1.5 text-xs leading-5 disabled:opacity-30 transition-colors hover:bg-[var(--paper-hover)]"
                      style={{ color: 'var(--ink-muted)', backgroundColor: 'var(--paper-hover)' }}
                      title="Go to last page"
                    >Last</button>
                    <div className="ml-auto flex items-center gap-1 text-xs" style={{ color: 'var(--ink-muted)' }}>
                      Go to
                      <input
                        type="text"
                        value={pageInput}
                        onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const n = parseInt(pageInput, 10);
                            if (!isNaN(n) && n >= 1 && n <= pageCount) {
                              gotoPage(n - 1);
                              setPageInput('');
                            }
                          }
                        }}
                        onBlur={() => setPageInput('')}
                        placeholder={String(currentPage + 1)}
                        className="w-8 rounded px-1 py-0.5 text-center text-xs outline-none"
                        style={{
                          border: '1px solid var(--input-border)',
                          backgroundColor: 'var(--input-bg)',
                          color: 'var(--ink)',
                        }}
                      />
                      / {pageCount}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 选中元素信息（已去除 CRT 终端显示器，仅保留选中提示 + selector + 取消选择） */}
            {selectedElement && (
              <div className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--line-soft)', backgroundColor: 'var(--primary-soft)' }}>
                <div className="flex items-center gap-1.5">
                  <MousePointer2 className="h-3 w-3 shrink-0" style={{ color: 'var(--primary)' }} />
                  <span className="text-xs font-medium shrink-0" style={{ color: 'var(--ink)' }}>Selected Element</span>
                  <span className="min-w-0 flex-1 truncate text-xs font-mono" style={{ color: 'color-mix(in oklab, var(--ink-muted) 70%, transparent)' }} title={selectedElement.selector}>
                    {selectedElement.selector}
                  </span>
                  <button
                    onClick={() => { setSelectedElement(null); clearTextSelection(); }}
                    className="shrink-0 rounded p-0.5 hover:bg-[var(--paper-hover)]"
                    style={{ color: 'var(--ink-muted)' }}
                    title="Deselect"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            )}

            {/* 指令/新文案输入：选中元素时 = 快速编辑（直替 / AI 优化 / 完整 AI 重写三个图标入口）；未选中 = 原全文档 AI 编辑 */}
            {selectedElement ? (
              <div className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--line-soft)' }}>
                {/* @chip：文字级选中时显示在输入框顶部（与 ChatNode 风格对齐），元素级选中不显示 chip */}
                {selectedText && (
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    <span
                      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-11 font-medium"
                      style={{
                        backgroundColor: 'var(--primary-soft)',
                        color: 'var(--primary)',
                        border: '1px solid rgba(75,63,227,0.4)',
                        lineHeight: 1,
                      }}
                    >
                      <span style={{ opacity: 0.85, fontWeight: 700, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace' }}>@</span>
                      <span className="truncate" style={{ maxWidth: 180 }} title={selectedText.text}>
                        &ldquo;{selectedText.textShort}&rdquo;
                      </span>
                      <span style={{ opacity: 0.55 }} className="hidden sm:inline max-w-[110px] truncate" title={selectedText.element.selector}>
                        in {selectedText.element.selector}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); clearTextSelection(); }}
                        className="ml-0.5 rounded p-0.5 hover:bg-white/60 transition-colors"
                        style={{ color: 'var(--primary)', opacity: 0.65 }}
                        title="Remove reference"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  </div>
                )}
                <textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      applyLocalReplace(instruction, aiDraftMode ? 'plain' : 'preserve');
                    }
                  }}
                  placeholder={aiDraftMode ? 'Draft ready — edit freely, then Confirm' : (selectedText ? `Refine or rewrite the highlighted text…` : `New text for <${selectedElement.tag}>…`)}
                  className="w-full resize-none rounded-md px-2.5 py-2 text-xs outline-none"
                  style={{
                    // 划词联动：文字被选中时输入框用品牌紫边框/浅紫底，与页面高亮 + @chip 形成"页面↔输入框"对应
                    border: selectedText ? '1px solid rgba(75,63,227,0.55)' : '1px solid var(--input-border)',
                    backgroundColor: selectedText ? 'color-mix(in oklab, var(--primary-soft) 65%, var(--input-bg))' : 'var(--input-bg)',
                    color: 'var(--ink)',
                    minHeight: '60px',
                    fontFamily: "var(--font-sans)",
                  }}
                  rows={3}
                />
                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    onClick={() => applyLocalReplace(instruction, 'preserve')}
                    disabled={!instruction.trim() || isProcessing}
                    className="flex w-9 shrink-0 items-center justify-center rounded-md py-2 transition-colors disabled:opacity-40"
                    style={{
                      backgroundColor: instruction.trim() && !isProcessing ? 'var(--primary)' : 'var(--paper-hover)',
                      color: instruction.trim() && !isProcessing ? 'var(--primary-foreground)' : 'var(--ink-muted)',
                    }}
                    title="Direct replace — swap text in place, keeps child tags"
                  >
                    <Replace className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={requestAiOptimize}
                    disabled={!instruction.trim() || isProcessing}
                    className="flex w-9 shrink-0 items-center justify-center rounded-md py-2 transition-colors disabled:opacity-40"
                    style={{
                      backgroundColor: instruction.trim() && !isProcessing ? 'var(--primary)' : 'var(--paper-hover)',
                      color: instruction.trim() && !isProcessing ? 'var(--primary-foreground)' : 'var(--ink-muted)',
                    }}
                    title={aiDraftMode ? 'Confirm — apply the draft as plain text' : 'AI optimize — generate a wording draft'}
                  >
                    {isProcessing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : aiDraftMode ? (
                      <Check className="h-3.5 w-3.5" />
                    ) : (
                      <Wand2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    onClick={applyInstruction}
                    disabled={!instruction.trim() || isProcessing}
                    className="flex w-9 shrink-0 items-center justify-center rounded-md py-2 transition-colors disabled:opacity-40"
                    style={{
                      backgroundColor: 'var(--paper-hover)',
                      color: instruction.trim() && !isProcessing ? 'var(--primary)' : 'var(--ink-muted)',
                    }}
                    title="Full AI edit — rewrite the whole element with AI"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                  </button>
                  {/* Cancel 槽位：固定宽度始终占位，处理中显示取消按钮——避免执行中插入按钮导致布局跳动 */}
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center">
                    {isProcessing && (
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--danger-soft)]"
                        style={{
                          backgroundColor: 'var(--paper-hover)',
                          color: 'var(--danger)',
                        }}
                        title="Cancel"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {/* 模型选择器（元素快速编辑分支，对齐 ChatNode 紧凑版） */}
                  <div className="ml-auto relative shrink-0" ref={aiModelMenuRef}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isProcessing) setAiModelMenuOpen((v) => !v);
                      }}
                      disabled={isProcessing}
                      className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                      style={{
                        backgroundColor: 'var(--paper-hover)',
                        color: 'var(--ink-muted)',
                      }}
                      title={aiModelId && aiModelId !== DEFAULT_MODEL_ID
                        ? aiRolePoolModels.find((m) => m.modelId === aiModelId)?.label ?? aiModelId
                        : 'Auto Mode'}
                    >
                      <span
                        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: (aiRolePoolModels.find((m) => m.modelId === aiModelId)?.thinking ?? true)
                            ? 'var(--primary-strong)'
                            : 'var(--ink-faint)',
                        }}
                      />
                      <span className="max-w-[110px] truncate">
                        {aiModelId && aiModelId !== DEFAULT_MODEL_ID
                          ? aiRolePoolModels.find((m) => m.modelId === aiModelId)?.label ?? aiModelId
                          : 'Auto'}
                      </span>
                      <ChevronDown className="h-2.5 w-2.5 opacity-50" />
                    </button>
                    {aiModelMenuOpen && (
                      <div
                        className="absolute right-0 bottom-full z-40 mb-1 max-h-64 w-52 overflow-y-auto rounded-xl border shadow-lg"
                        style={{
                          borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                          backgroundColor: 'var(--popover)',
                        }}
                      >
                        {(() => {
                          const groups: Record<string, AvailableModel[]> = {};
                          for (const m of aiRolePoolModels) {
                            if (!groups[m.group]) groups[m.group] = [];
                            groups[m.group].push(m);
                          }
                          const groupEntries = Object.entries(groups);
                          return (
                            <>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAiModelId(DEFAULT_MODEL_ID);
                                  setAiModelMenuOpen(false);
                                }}
                                className="flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors"
                                style={{
                                  backgroundColor: aiModelId === DEFAULT_MODEL_ID ? 'var(--paper-soft)' : 'transparent',
                                  borderBottom: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
                                }}
                                onMouseEnter={(e) => {
                                  if (aiModelId !== DEFAULT_MODEL_ID) {
                                    e.currentTarget.style.backgroundColor = 'var(--paper-muted)';
                                  }
                                }}
                                onMouseLeave={(e) => {
                                  if (aiModelId !== DEFAULT_MODEL_ID) {
                                    e.currentTarget.style.backgroundColor = 'transparent';
                                  }
                                }}
                              >
                                <div className="flex flex-1 flex-col">
                                  <span className="text-xs font-medium" style={{ color: 'var(--ink)' }}>Auto</span>
                                  <span className="text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
                                    自动选择最佳模型
                                  </span>
                                </div>
                                {aiModelId === DEFAULT_MODEL_ID && (
                                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                                )}
                              </button>
                              {groupEntries.length === 0 ? (
                                <div className="px-2.5 py-3 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                                  未配置主对话模型，请到 设置 → Role Assignment 中指定
                                </div>
                              ) : groupEntries.map(([groupName, models]) => (
                                <div key={groupName}>
                                  <div
                                    className="px-2.5 py-1 text-xs font-semibold uppercase tracking-wide"
                                    style={{
                                      color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)',
                                      backgroundColor: 'var(--paper-soft)',
                                    }}
                                  >
                                    {groupName}
                                  </div>
                                  {models.map((m) => (
                                    <button
                                      key={m.modelId}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setAiModelId(m.modelId);
                                        setAiModelMenuOpen(false);
                                      }}
                                      className="flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors"
                                      style={{ backgroundColor: m.modelId === aiModelId ? 'var(--paper-soft)' : 'transparent' }}
                                      onMouseEnter={(e) => {
                                        if (m.modelId !== aiModelId) e.currentTarget.style.backgroundColor = 'var(--paper-muted)';
                                      }}
                                      onMouseLeave={(e) => {
                                        if (m.modelId !== aiModelId) e.currentTarget.style.backgroundColor = 'transparent';
                                      }}
                                    >
                                      <div className="flex flex-1 flex-col">
                                        <span className="truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>
                                          {m.label}
                                        </span>
                                      </div>
                                      {m.modelId === aiModelId && (
                                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                                      )}
                                    </button>
                                  ))}
                                </div>
                              ))}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAiModelMenuOpen(false);
                                  window.dispatchEvent(new CustomEvent('open-settings', { detail: { section: 'roles' } }));
                                }}
                                className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors"
                                style={{
                                  borderTop: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
                                  backgroundColor: 'transparent',
                                }}
                                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--paper-muted)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                              >
                                <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                                <span className="text-xs font-medium" style={{ color: 'var(--ink)' }}>
                                  管理模型…
                                </span>
                              </button>
                            </>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                </div>
                {quickStatus && (
                  <div
                    className="mt-1.5 rounded-md px-2 py-1.5 text-xs"
                    style={{
                      backgroundColor: quickStatus.type === 'ok' ? 'var(--success-soft)' : 'var(--danger-soft)',
                      color: quickStatus.type === 'ok' ? 'var(--success)' : 'var(--ink)',
                    }}
                  >
                    {quickStatus.text}
                  </div>
                )}
                {error && (
                  <div className="mt-1.5 rounded-md px-2 py-1.5 text-xs" style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--ink)' }}>
                    {error}
                  </div>
                )}
              </div>
            ) : (
              <div className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--line-soft)' }}>
                {selectedText && (
                  <div className="mb-2 flex flex-wrap items-center gap-1.5">
                    <span
                      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-11 font-medium"
                      style={{
                        backgroundColor: 'var(--primary-soft)',
                        color: 'var(--primary)',
                        border: '1px solid rgba(75,63,227,0.4)',
                        lineHeight: 1,
                      }}
                    >
                      <span style={{ opacity: 0.85, fontWeight: 700, fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace' }}>@</span>
                      <span className="truncate" style={{ maxWidth: 180 }} title={selectedText.text}>
                        &ldquo;{selectedText.textShort}&rdquo;
                      </span>
                      <span style={{ opacity: 0.55 }} className="hidden sm:inline max-w-[110px] truncate" title={selectedText.element.selector}>
                        in {selectedText.element.selector}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); clearTextSelection(); }}
                        className="ml-0.5 rounded p-0.5 hover:bg-white/60 transition-colors"
                        style={{ color: 'var(--primary)', opacity: 0.65 }}
                        title="Remove reference"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  </div>
                )}
                <textarea
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      applyInstruction();
                    }
                  }}
                  placeholder={selectedText ? `Refine or rewrite the highlighted text…` : "Edit the whole page... (select an element for quick replace)"}
                  className="w-full resize-none rounded-md px-2.5 py-2 text-xs outline-none"
                  style={{
                    // 划词联动：文字被选中时输入框用品牌紫边框/浅紫底，与页面高亮 + @chip 形成"页面↔输入框"对应
                    border: selectedText ? '1px solid rgba(75,63,227,0.55)' : '1px solid var(--input-border)',
                    backgroundColor: selectedText ? 'color-mix(in oklab, var(--primary-soft) 65%, var(--input-bg))' : 'var(--input-bg)',
                    color: 'var(--ink)',
                    minHeight: '60px',
                    fontFamily: "var(--font-sans)",
                  }}
                  rows={3}
                />
                <div className="mt-2 flex items-center gap-1.5">
                  <button
                    onClick={applyInstruction}
                    disabled={!instruction.trim() || isProcessing}
                    className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 transition-colors disabled:opacity-40"
                    style={{
                      backgroundColor: instruction.trim() && !isProcessing ? 'var(--primary)' : 'var(--paper-hover)',
                      color: instruction.trim() && !isProcessing ? 'var(--primary-foreground)' : 'var(--ink-muted)',
                    }}
                    title="Apply"
                  >
                    {isProcessing ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span className="min-w-0 truncate text-xs font-medium">
                      {isProcessing
                        ? streamPhase === 'connecting'
                          ? 'Connecting…'
                          : streamPhase === 'retry'
                          ? `Correcting… · ${streamTokens} tok`
                          : streamTokens > 0
                          ? `Generating… · ${streamTokens} tok`
                          : 'Generating…'
                        : 'Apply AI Edit'}
                    </span>
                  </button>
                  {/* Cancel 槽位：固定宽度始终占位，处理中显示取消按钮——避免执行中插入按钮导致布局跳动 */}
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center">
                    {isProcessing && (
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--danger-soft)]"
                        style={{
                          backgroundColor: 'var(--paper-hover)',
                          color: 'var(--danger)',
                        }}
                        title="Cancel"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {/* 模型选择器（全文档编辑分支，对齐 ChatNode 紧凑版） */}
                  <div className="ml-auto relative shrink-0" ref={aiModelMenuRef}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!isProcessing) setAiModelMenuOpen((v) => !v);
                      }}
                      disabled={isProcessing}
                      className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                      style={{
                        backgroundColor: 'var(--paper-hover)',
                        color: 'var(--ink-muted)',
                      }}
                      title={aiModelId && aiModelId !== DEFAULT_MODEL_ID
                        ? aiRolePoolModels.find((m) => m.modelId === aiModelId)?.label ?? aiModelId
                        : 'Auto Mode'}
                    >
                      <span
                        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: (aiRolePoolModels.find((m) => m.modelId === aiModelId)?.thinking ?? true)
                            ? 'var(--primary-strong)'
                            : 'var(--ink-faint)',
                        }}
                      />
                      <span className="max-w-[110px] truncate">
                        {aiModelId && aiModelId !== DEFAULT_MODEL_ID
                          ? aiRolePoolModels.find((m) => m.modelId === aiModelId)?.label ?? aiModelId
                          : 'Auto'}
                      </span>
                      <ChevronDown className="h-2.5 w-2.5 opacity-50" />
                    </button>
                    {aiModelMenuOpen && (
                      <div
                        className="absolute right-0 bottom-full z-40 mb-1 max-h-64 w-52 overflow-y-auto rounded-xl border shadow-lg"
                        style={{
                          borderColor: 'color-mix(in oklab, var(--line) 30%, transparent)',
                          backgroundColor: 'var(--popover)',
                        }}
                      >
                        {(() => {
                          const groups: Record<string, AvailableModel[]> = {};
                          for (const m of aiRolePoolModels) {
                            if (!groups[m.group]) groups[m.group] = [];
                            groups[m.group].push(m);
                          }
                          const groupEntries = Object.entries(groups);
                          return (
                            <>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAiModelId(DEFAULT_MODEL_ID);
                                  setAiModelMenuOpen(false);
                                }}
                                className="flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors"
                                style={{
                                  backgroundColor: aiModelId === DEFAULT_MODEL_ID ? 'var(--paper-soft)' : 'transparent',
                                  borderBottom: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
                                }}
                                onMouseEnter={(e) => {
                                  if (aiModelId !== DEFAULT_MODEL_ID) {
                                    e.currentTarget.style.backgroundColor = 'var(--paper-muted)';
                                  }
                                }}
                                onMouseLeave={(e) => {
                                  if (aiModelId !== DEFAULT_MODEL_ID) {
                                    e.currentTarget.style.backgroundColor = 'transparent';
                                  }
                                }}
                              >
                                <div className="flex flex-1 flex-col">
                                  <span className="text-xs font-medium" style={{ color: 'var(--ink)' }}>Auto</span>
                                  <span className="text-xs" style={{ color: 'color-mix(in oklab, var(--ink-muted) 60%, transparent)' }}>
                                    自动选择最佳模型
                                  </span>
                                </div>
                                {aiModelId === DEFAULT_MODEL_ID && (
                                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                                )}
                              </button>
                              {groupEntries.length === 0 ? (
                                <div className="px-2.5 py-3 text-xs leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
                                  未配置主对话模型，请到 设置 → Role Assignment 中指定
                                </div>
                              ) : groupEntries.map(([groupName, models]) => (
                                <div key={groupName}>
                                  <div
                                    className="px-2.5 py-1 text-xs font-semibold uppercase tracking-wide"
                                    style={{
                                      color: 'color-mix(in oklab, var(--ink-muted) 50%, transparent)',
                                      backgroundColor: 'var(--paper-soft)',
                                    }}
                                  >
                                    {groupName}
                                  </div>
                                  {models.map((m) => (
                                    <button
                                      key={m.modelId}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setAiModelId(m.modelId);
                                        setAiModelMenuOpen(false);
                                      }}
                                      className="flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors"
                                      style={{ backgroundColor: m.modelId === aiModelId ? 'var(--paper-soft)' : 'transparent' }}
                                      onMouseEnter={(e) => {
                                        if (m.modelId !== aiModelId) e.currentTarget.style.backgroundColor = 'var(--paper-muted)';
                                      }}
                                      onMouseLeave={(e) => {
                                        if (m.modelId !== aiModelId) e.currentTarget.style.backgroundColor = 'transparent';
                                      }}
                                    >
                                      <div className="flex flex-1 flex-col">
                                        <span className="truncate text-xs font-medium" style={{ color: 'var(--ink)' }}>
                                          {m.label}
                                        </span>
                                      </div>
                                      {m.modelId === aiModelId && (
                                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                                      )}
                                    </button>
                                  ))}
                                </div>
                              ))}
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setAiModelMenuOpen(false);
                                  window.dispatchEvent(new CustomEvent('open-settings', { detail: { section: 'roles' } }));
                                }}
                                className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors"
                                style={{
                                  borderTop: '1px solid color-mix(in oklab, var(--line) 30%, transparent)',
                                  backgroundColor: 'transparent',
                                }}
                                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--paper-muted)'; }}
                                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                              >
                                <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
                                <span className="text-xs font-medium" style={{ color: 'var(--ink)' }}>
                                  管理模型…
                                </span>
                              </button>
                            </>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                </div>
                {error && (
                  <div className="mt-1.5 rounded-md px-2 py-1.5 text-xs" style={{ backgroundColor: 'var(--danger-soft)', color: 'var(--primary)' }}>
                    {error}
                  </div>
                )}
              </div>
            )}

            {/* 撤销/重做 + 保存状态 */}
            <div className="flex items-center gap-1 px-3 py-2" style={{ borderBottom: '1px solid var(--line-soft)' }}>
              <button
                onClick={handleUndo}
                disabled={undoStack.length === 0}
                className="flex items-center justify-center rounded-md p-1.5 transition-colors disabled:opacity-30"
                style={{ color: 'var(--ink-muted)' }}
                title="Undo"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={handleRedo}
                disabled={redoStack.length === 0}
                className="flex items-center justify-center rounded-md p-1.5 transition-colors disabled:opacity-30"
                style={{ color: 'var(--ink-muted)' }}
                title="Redo"
              >
                <Redo2 className="h-3.5 w-3.5" />
              </button>
              <span className="ml-auto text-xs" style={{ color: saveStatus === 'saved' ? 'var(--success)' : 'var(--ink-faint)' }}>
                {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : canSave ? 'Auto-save' : 'Preview only'}
              </span>
            </div>

            {/* 编辑历史（默认折叠） */}
            {undoStack.length > 0 && (
              <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--line-soft)' }}>
                <button
                  onClick={() => setHistoryExpanded((v) => !v)}
                  className="flex w-full items-center gap-1 text-xs font-medium transition-colors hover:opacity-70"
                  style={{ color: 'var(--ink-muted)' }}
                  title={historyExpanded ? 'Collapse history' : 'Expand history'}
                >
                  History ({undoStack.length})
                  {historyExpanded
                    ? <ChevronUp className="ml-auto h-3 w-3 shrink-0" />
                    : <ChevronDown className="ml-auto h-3 w-3 shrink-0" />}
                </button>
                {historyExpanded && (
                  <div className="mt-1.5 space-y-1">
                    {undoStack.slice(-5).reverse().map((r, i) => {
                      const entryNo = undoStack.length - i;
                      const batchPoints = r.changePoints && r.changePoints.length > 1 ? r.changePoints : null;
                      const isOpen = expandedHistoryId === entryNo;
                      return (
                        <div key={i} className="rounded-md px-2 py-1 text-xs" style={{ backgroundColor: 'var(--paper-hover)', color: 'var(--ink-muted)' }}>
                          <div className="flex items-center gap-1">
                            <span style={{ color: 'var(--ink-faint)' }}>{entryNo}.</span>
                            <span className="min-w-0 flex-1 truncate" title={r.instruction}>
                              {r.instruction.slice(0, 40)}
                              {r.instruction.length > 40 ? '...' : ''}
                            </span>
                            {batchPoints && (
                              <span className="rounded px-1 py-px text-10" style={{ backgroundColor: 'var(--info-soft)', color: 'var(--info)' }}>
                                {batchPoints.length} changes
                              </span>
                            )}
                            {batchPoints ? (
                              <button
                                onClick={() => setExpandedHistoryId(isOpen ? null : entryNo)}
                                className="rounded p-0.5 transition-colors hover:bg-[var(--paper)]"
                                style={{ color: 'var(--ink-muted)' }}
                                title={isOpen ? 'Collapse changes' : 'Expand changes'}
                              >
                                {isOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                              </button>
                            ) : (
                              <>
                                <button
                                  onClick={() => r.elementSelector && handleLocateSelector(r.elementSelector)}
                                  disabled={!r.elementSelector}
                                  className="rounded p-0.5 transition-colors hover:bg-[var(--paper)] disabled:opacity-30"
                                  style={{ color: 'var(--ink-muted)' }}
                                  title="Locate change in preview"
                                >
                                  <LocateFixed className="h-3 w-3" />
                                </button>
                                <button
                                  onClick={() => openDiff(r)}
                                  className="rounded p-0.5 transition-colors hover:bg-[var(--paper)]"
                                  style={{ color: 'var(--ink-muted)' }}
                                  title="View before / after diff"
                                >
                                  <GitCompareArrows className="h-3 w-3" />
                                </button>
                              </>
                            )}
                          </div>
                          {batchPoints && isOpen && (
                            <div className="mt-1 space-y-0.5">
                              {batchPoints.map((cp, ci) => (
                                <div key={ci} className="flex items-center gap-1 rounded px-1 py-0.5" style={{ backgroundColor: 'var(--paper)' }}>
                                  <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--ink-muted)' }} title={cp.selector}>
                                    {cp.selector}
                                  </span>
                                  <button
                                    onClick={() => handleLocateSelector(cp.selector)}
                                    className="rounded p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
                                    style={{ color: 'var(--ink-muted)' }}
                                    title="Locate change in preview"
                                  >
                                    <LocateFixed className="h-3 w-3" />
                                  </button>
                                  <button
                                    onClick={() => openDiffPoint(r, cp)}
                                    className="rounded p-0.5 transition-colors hover:bg-[var(--paper-hover)]"
                                    style={{ color: 'var(--ink-muted)' }}
                                    title="View before / after diff"
                                  >
                                    <GitCompareArrows className="h-3 w-3" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

          </div>
        )}
      </div>,
      document.body,
    )}

    {/* 历史 diff 弹窗：查看修改前后对比 */}
    {diffTarget && (
      <div
        onClick={() => setDiffTarget(null)}
        style={{ position: 'fixed', inset: 0, zIndex: 99999, backgroundColor: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex max-h-[80vh] w-[720px] max-w-[90vw] flex-col overflow-hidden rounded-lg"
          style={{ backgroundColor: 'var(--paper)', border: '1px solid var(--line)', boxShadow: '0 12px 40px rgba(0,0,0,0.3)' }}
        >
          <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--line-soft)' }}>
            <GitCompareArrows className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--primary)' }} />
            <span className="text-xs font-medium" style={{ color: 'var(--ink)' }}>Before / After Diff</span>
            <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--ink-muted)' }} title={diffTarget.instruction}>
              {diffTarget.instruction}
            </span>
            <button onClick={() => setDiffTarget(null)} className="rounded p-0.5 hover:bg-[var(--paper-hover)]" style={{ color: 'var(--ink-muted)' }} title="Close">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="ai-canvas-scroll flex-1 overflow-y-auto px-3 py-2 font-mono text-xs" style={{ color: 'var(--ink)' }}>
            {(() => {
              const isElementScope = diffTarget.scope !== 'Whole document';
              const lines = diffLines(diffTarget.beforeHtml, diffTarget.afterHtml);
              return (
                <>
                  <div className="mb-1.5" style={{ color: 'var(--ink-faint)' }}>
                    Scope: {diffTarget.scope}
                    {isElementScope && !diffTarget.beforeHtml ? ' · new element (added)' : ''}
                    {isElementScope && !diffTarget.afterHtml ? ' · element removed' : ''}
                  </div>
                  {lines.map((ln, k) => {
                    const style = ln.kind === 'add'
                      ? { backgroundColor: 'var(--success-soft)', color: 'var(--success)' }
                      : ln.kind === 'del'
                        ? { backgroundColor: 'var(--danger-soft)', color: 'var(--danger)' }
                        : { color: 'var(--ink-muted)' };
                    return (
                      <div key={k} className="flex gap-2 whitespace-pre-wrap break-all rounded-sm px-1" style={style}>
                        <span className="w-3 shrink-0" style={{ opacity: 0.6 }}>{ln.kind === 'add' ? '+' : ln.kind === 'del' ? '-' : ' '}</span>
                        <span className="min-w-0 flex-1">{ln.text || ' '}</span>
                      </div>
                    );
                  })}
                </>
              );
            })()}
          </div>
        </div>
      </div>
    )}
    </>
  );
}
