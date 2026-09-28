"""Local DOM regression suite. Does NOT connect to a real ChatGPT account.
Run: python tests/browser_tests.py [navigation|stay|extra]
Requires Python Playwright and Chromium. JS runs in a CDP ISOLATED world.
The manifest installation / Chrome storage permissions are not exercised.
"""
from pathlib import Path
import json, sys, os, html
from playwright.sync_api import sync_playwright
BASE = Path(__file__).resolve().parents[1]
RESULTS = []


def fixture(reverse=False, window=False, hidden=False, marked=True, legacy=False, extra=''):
    turns = ''
    for i in range(1, 21):
        attrs = f'data-turn-key="t{i}"' if not legacy else f'data-testid="conversation-turn-{i}" data-turn="user"'
        marker = 'data-user-message-bubble' if not legacy else 'data-message-author-role="user"'
        turns += f'<section {attrs} id="q{i}" style="height:300px;padding:20px;box-sizing:border-box"><div {marker}><div class="whitespace-pre-wrap">PRIVATE_QUESTION_{i}</div></div><p>PRIVATE_ANSWER_{i}</p></section>'
    if window:
        css='html,body{margin:0}main{width:700px}'
        body=f'<main>{turns}</main>'
    else:
        css=f'''html,body{{margin:0;height:100%;overflow:hidden}}#scroller{{height:700px;overflow-y:{'hidden' if hidden else 'auto'};display:flex;flex-direction:{'column-reverse' if reverse else 'column'};border:2px solid transparent;}}main{{flex:none;width:700px;}}'''
        body=f'<div id="scroller" {"data-app-action-timeline-scroll" if marked else ""}><main>{turns}</main></div>'
    return f'<!doctype html><meta charset="utf-8"><style>{css}</style>{body}{extra}'


def load(browser, **kw):
    page=browser.new_page(viewport={'width':1280,'height':800})
    errors=[];page.on('pageerror',lambda e: errors.append(str(e)))
    page.set_content(fixture(**kw))
    page.evaluate('''() => {window.s=document.querySelector('#scroller')||document.scrollingElement;
        s.scrollTop=getComputedStyle(s).flexDirection==='column-reverse'?0:s.scrollHeight;
        window.orig={scrollTo:Element.prototype.scrollTo,scrollIntoView:Element.prototype.scrollIntoView,
        setter:Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop').set,focus:HTMLElement.prototype.focus};}''')
    session=page.context.new_cdp_session(page)
    frame=session.send('Page.getFrameTree')['frameTree']['frame']['id']
    world=session.send('Page.createIsolatedWorld',{'frameId':frame,'worldName':'CGNavigatorRegression'})['executionContextId']
    def isolated(code):
        r=session.send('Runtime.evaluate',{'expression':code,'contextId':world,'returnByValue':True})
        if 'exceptionDetails' in r:raise RuntimeError(r['exceptionDetails'])
        return r.get('result',{}).get('value')
    for file in ['scroll-core.js','content.js']: isolated((BASE/file).read_text())
    page.wait_for_timeout(100)
    return page,isolated,errors


def add(name, passed, data=None):
    RESULTS.append({'name':name,'passed':bool(passed),'data':data})
    print(('PASS' if passed else 'FAIL'),name, json.dumps(data,ensure_ascii=False) if data is not None else '',flush=True)


def info(page,number=5):
    return page.evaluate('''i => {const el=document.querySelector('#q'+i+' > div');
        const root=s===document.scrollingElement?{top:0}:s.getBoundingClientRect();
        return {scrollTop:s.scrollTop,targetTop:el.getBoundingClientRect().top-root.top-(s===document.scrollingElement?0:s.clientTop),height:s.clientHeight,range:s.scrollHeight-s.clientHeight};}''',number)


def click(page,number=5):
    page.locator('#chatgpt-navigator-v3').locator('.item').nth(number-1).click()


def report(page):
    # about:blank has no clipboard capability; the built-in textarea fallback is used.
    page.locator('#chatgpt-navigator-v3').locator('.diagnostic').click()
    page.wait_for_timeout(40)
    return json.loads(page.locator('#chatgpt-navigator-v3').locator('textarea').input_value())


def nav_suite(browser):
    for name,kw in [('normal',{}),('reverse',{'reverse':True}),('window',{'window':True}),
                    ('hidden-fallback',{'hidden':True,'marked':False}),
                    ('reverse-unmarked',{'reverse':True,'marked':False}),
                    ('legacy',{'legacy':True})]:
        page,iso,errors=load(browser,**kw)
        click(page);page.wait_for_timeout(350)
        d=info(page)
        add(name+'-prompt-5-aligned',abs(d['targetTop']-d['height']*.22)<1.5,d)
        if kw.get('reverse'):add(name+'-negative-preserved',d['scrollTop']<0)
        page.locator('#chatgpt-navigator-v3').locator('.next').click();page.wait_for_timeout(300)
        d=info(page,6);add(name+'-next',abs(d['targetTop']-d['height']*.22)<1.5)
        page.keyboard.press('Alt+ArrowUp');page.wait_for_timeout(300)
        d=info(page,5);add(name+'-shortcut-prev',abs(d['targetTop']-d['height']*.22)<1.5)
        # Page-owned script jump while Follow is on. We must NOT fight it, even in the settle window.
        click(page,4)
        page.evaluate("s.scrollTop=getComputedStyle(s).flexDirection==='column-reverse'?0:s.scrollHeight")
        page.wait_for_timeout(1300)
        top=page.evaluate('s.scrollTop');expected=0 if kw.get('reverse') else page.evaluate('s.scrollHeight-s.clientHeight')
        add(name+'-follow-does-not-pin',abs(top-expected)<1.5,{'actual':top,'expected':expected})
        rep=report(page)
        add(name+'-single-navigation-write',len(rep['lastJump']['writes'])==1,rep['lastJump']['writes'])
        add(name+'-diagnostic-no-content',not any(x in json.dumps(rep) for x in ['PRIVATE_','data-turn-key:t','/c/']))
        add(name+'-page-APIs-untouched',page.evaluate("orig.scrollTo===Element.prototype.scrollTo && orig.scrollIntoView===Element.prototype.scrollIntoView && orig.setter===Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop').set && orig.focus===HTMLElement.prototype.focus"))
        add(name+'-isolated-world',page.evaluate('typeof CGNavScroll')=='undefined')
        add(name+'-no-page-errors',not errors,errors)
        page.close()


def stay_suite(browser):
    for reverse in [False,True]:
        name='reverse' if reverse else 'normal'
        page,iso,errors=load(browser,reverse=reverse)
        click(page);page.wait_for_timeout(320)
        page.locator('#chatgpt-navigator-v3').locator('.stay').click()
        before=info(page)
        # Genuine layout change, no fake hostile auto-scroll.
        page.evaluate("document.querySelector('#q20').style.height='500px'")
        page.wait_for_timeout(350)
        after=info(page)
        add(name+'-stay-bottom-growth',abs(before['targetTop']-after['targetTop'])<1.5,{'before':before,'after':after})
        page.evaluate("document.querySelector('#q1').style.height='450px'")
        page.wait_for_timeout(350)
        after2=info(page)
        add(name+'-stay-above-growth',abs(before['targetTop']-after2['targetTop'])<1.5)
        # Direct page-owned jump while Stay explicitly on.
        page.evaluate("s.scrollTop=getComputedStyle(s).flexDirection==='column-reverse'?0:s.scrollHeight")
        page.wait_for_timeout(350)
        after3=info(page)
        add(name+'-stay-explicit-restore',abs(before['targetTop']-after3['targetTop'])<1.5)
        # Real wheel (trusted browser input) updates the anchor instead of snapping back.
        page.mouse.move(450,350);page.mouse.wheel(0,210);page.wait_for_timeout(600)
        user=info(page)
        page.wait_for_timeout(350)
        stable=info(page)
        add(name+'-stay-allows-user-wheel',abs(user['scrollTop']-after3['scrollTop'])>100 and abs(stable['scrollTop']-user['scrollTop'])<1.5,{'before':after3,'wheel':user,'stable':stable})
        # Continuous bottom growth must not be mistaken for a scroll-controller fight.
        page.evaluate("window.streamSteps=0;window.streamTimer=setInterval(()=>{const el=document.querySelector('#q20');el.style.height=(parseFloat(el.style.height)+4)+'px';if(++window.streamSteps>=30)clearInterval(window.streamTimer)},25)")
        page.wait_for_timeout(1000)
        streamed=info(page)
        pressed=page.locator('#chatgpt-navigator-v3').locator('.stay').get_attribute('aria-pressed')
        add(name+'-stay-continuous-streaming',pressed=='true' and abs(streamed['targetTop']-stable['targetTop'])<1.5,{'pressed':pressed,'before':stable,'after':streamed})
        # Rapid navigation cannot restore an obsolete anchor.
        click(page,7);click(page,3);page.wait_for_timeout(350)
        d=info(page,3);add(name+'-stay-rapid-jump',abs(d['targetTop']-d['height']*.22)<1.5,d)
        # Explicit Follow removes all reading-position maintenance.
        page.locator('#chatgpt-navigator-v3').locator('.stay').click()
        page.evaluate("s.scrollTop=getComputedStyle(s).flexDirection==='column-reverse'?0:s.scrollHeight")
        page.wait_for_timeout(400)
        top=page.evaluate('s.scrollTop');expected=0 if reverse else page.evaluate('s.scrollHeight-s.clientHeight')
        add(name+'-stay-off-release',abs(top-expected)<1.5)
        add(name+'-stay-no-errors',not errors,errors)
        page.close()


def extra_suite(browser):
    page,iso,errors=load(browser,reverse=True)
    # Native methods handle fractional positions and browser range clamps.
    got=iso("CGNavScroll.write(document.querySelector('#scroller'), -1234.5)")
    add('signed-core-fractional-write',abs(got['actual']+1234.5)<=1,got)
    got=iso("CGNavScroll.write(document.querySelector('#scroller'), -999999)")
    add('signed-core-native-lower-clamp',got['actual']<0 and abs(got['actual']+page.evaluate('s.scrollHeight-s.clientHeight'))<1,got)
    # Persistent shell with temporarily absent children: do not lose question labels.
    page.evaluate("window.saved=document.querySelector('#q5').innerHTML;document.querySelector('#q5').replaceChildren()")
    page.wait_for_timeout(300)
    items=page.locator('#chatgpt-navigator-v3').locator('.item')
    add('virtual-shell-index-retained',items.count()==20 and 'PRIVATE_QUESTION_5' in items.nth(4).inner_text())
    click(page);page.wait_for_timeout(300)
    top=page.evaluate("document.querySelector('#q5').getBoundingClientRect().top-s.getBoundingClientRect().top-s.clientTop")
    add('virtual-shell-navigation',abs(top-700*.22)<1.5,top)
    page.evaluate("document.querySelector('#q5').innerHTML=window.saved")
    page.wait_for_timeout(300)
    add('virtual-shell-remount-index',items.count()==20)
    # Follow: real layout shift during initial navigation is corrected at most twice.
    click(page)
    page.evaluate("s.style.overflowAnchor='none';document.querySelector('#q20').style.height='470px'")
    page.wait_for_timeout(400)
    d=info(page);add('bounded-layout-correction',abs(d['targetTop']-d['height']*.22)<1.5,d)
    rep=report(page)
    add('bounded-layout-write-count',1<len(rep['lastJump']['writes'])<=3,rep['lastJump']['writes'])
    # A whole turn removed: no stale entry to a different question.
    page.evaluate("document.querySelector('#q7').remove()")
    page.wait_for_timeout(300);add('branch-removal-no-ghost',items.count()==19)
    # Newly appended prompt picks up automatically.
    page.evaluate("const p=document.createElement('section');p.dataset.turnKey='t21';p.innerHTML='<div data-user-message-bubble>PRIVATE_NEW_PROMPT</div>';document.querySelector('main').append(p)")
    page.wait_for_timeout(300);add('new-prompt-detected',items.count()==20 and 'PRIVATE_NEW_PROMPT' in items.last.inner_text())
    # No target geometry -> no forced scroll.
    page.evaluate("document.querySelector('#q6').style.height='0px';document.querySelector('#q6').style.padding='0';document.querySelector('#q6').replaceChildren()")
    page.wait_for_timeout(250);before=page.evaluate('s.scrollTop');click(page,6);page.wait_for_timeout(300)
    add('zero-height-target-not-guessed',abs(page.evaluate('s.scrollTop')-before)<1.5)
    add('extra-no-errors',not errors,errors)
    # Save screenshot for visual inspection.
    page.screenshot(path=str(BASE/'tests'/'ui-preview.png'))
    page.close()
    # Put a tall hidden wrapper around the real marked reverse scroller.
    page,iso,errors=load(browser,reverse=True)
    page.evaluate("const outer=document.createElement('div');outer.id='outer';outer.style.cssText='height:720px;overflow:hidden';s.before(outer);outer.append(s);const filler=document.createElement('div');filler.style.height='900px';outer.append(filler)")
    click(page);page.wait_for_timeout(350);d=info(page)
    add('nested-root-not-all-ancestors',abs(d['targetTop']-d['height']*.22)<1.5 and page.evaluate('document.querySelector("#outer").scrollTop')==0,d)
    page.close()


if __name__=='__main__':
    group=sys.argv[1] if len(sys.argv)>1 else 'all'
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
        browser_version=browser.version
        for name,func in [('navigation',nav_suite),('stay',stay_suite),('extra',extra_suite)]:
            if group in [name,'all']:func(browser)
        browser.close()
    data={'scope':'Local synthetic DOM; CDP isolated-world JS, not a logged-in ChatGPT test; manifest installation and storage not tested.',
          'browser':browser_version,'group':group,'passed':sum(x['passed'] for x in RESULTS),'total':len(RESULTS),'tests':RESULTS}
    (BASE/'tests'/f'results-{group}.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
    print(f"{data['passed']}/{data['total']} passed")
    sys.exit(0 if all(x['passed'] for x in RESULTS) else 1)
