"""Compare original v2.0.3 with v3, without any ChatGPT / hostile page scripts.
Usage: python tests/compare_v203.py /path/to/chatgpt-nav-extension-v2.0.3.zip
"""
from pathlib import Path
import json, sys, zipfile
from playwright.sync_api import sync_playwright
from browser_tests import fixture
BASE=Path(__file__).resolve().parents[1]
old_zip=Path(sys.argv[1]) if len(sys.argv)>1 else BASE.parent/'chatgpt-nav-extension-v2.0.3.zip'
with zipfile.ZipFile(old_zip) as archive:
    path=next(n for n in archive.namelist() if n.endswith('/content.js'))
    old=archive.read(path).decode()
results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    version=browser.version
    for reverse in [False,True]:
        for extension in ['2.0.3','3.0.0']:
            page=browser.new_page(viewport={'width':1280,'height':800})
            page.set_content(fixture(reverse=reverse))
            page.evaluate("window.s=document.querySelector('#scroller');s.scrollTop=getComputedStyle(s).flexDirection==='column-reverse'?0:s.scrollHeight")
            client=page.context.new_cdp_session(page)
            frame=client.send('Page.getFrameTree')['frameTree']['frame']['id']
            world=client.send('Page.createIsolatedWorld',{'frameId':frame,'worldName':'regression-compare'})['executionContextId']
            codes=[old] if extension=='2.0.3' else [(BASE/'scroll-core.js').read_text(),(BASE/'content.js').read_text()]
            for code in codes:
                r=client.send('Runtime.evaluate',{'expression':code,'contextId':world})
                if 'exceptionDetails' in r:raise RuntimeError(r['exceptionDetails'])
            page.wait_for_timeout(120)
            selector='#chatgpt-navigator-stay-v2 .toc-item' if extension=='2.0.3' else '#chatgpt-navigator-v3 .item'
            page.locator(selector).nth(4).click()
            page.wait_for_timeout(1700)
            metrics=page.evaluate("({scrollTop:s.scrollTop,targetTop:document.querySelector('#q5 > div').getBoundingClientRect().top-s.getBoundingClientRect().top-s.clientTop,viewport:s.clientHeight})")
            row={'layout':'bottom-origin-column-reverse' if reverse else 'normal-top-origin','extension':extension,'afterClick':metrics}
            if reverse:
                page.evaluate('s.scrollTop=-1000')
                row['externalWriteRequested']=-1000
                page.wait_for_timeout(300)
                row['after300ms']=page.evaluate('s.scrollTop')
            results.append(row);print(row,flush=True)
            page.close()
    browser.close()
data={'scope':'Synthetic static DOM only. No ChatGPT JavaScript or forced-bottom page controller. Both extensions executed in isolated worlds.','browser':version,'results':results}
(BASE/'tests'/'v203-v3-comparison.json').write_text(json.dumps(data,indent=2))
