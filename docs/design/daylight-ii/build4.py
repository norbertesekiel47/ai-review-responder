import base64
logo=open('logo_datauri.txt').read().strip()
wash='data:image/jpeg;base64,'+base64.b64encode(open('media/wash_poster.jpg','rb').read()).decode()
vid='data:video/mp4;base64,'+base64.b64encode(open('media/wash_loop.mp4','rb').read()).decode()
s=open('demo4-daylight-v2.src.html').read()
s=s.replace('__LOGO__',logo).replace('__WASHVID__',vid).replace('__WASH__',wash)
open('demo4-daylight-v2.html','w').write(s)
print('built', len(s))
