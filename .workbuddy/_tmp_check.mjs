process.env.HTTP_PROXY='';process.env.http_proxy='';process.env.HTTPS_PROXY='';process.env.https_proxy='';
const fs = require('fs');
const out = (s) => fs.appendFileSync('C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发/实践任务3：后端开发(前后端分离)/.workbuddy/_tmp_check.out', s + '\n');
fs.writeFileSync('C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发/实践任务3：后端开发(前后端分离)/.workbuddy/_tmp_check.out', '');
fetch('http://127.0.0.1:8080/api/user/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'admin123'})})
  .then(r=>r.json().then(j=>out('OK status='+r.status+' code='+j.code+' role='+(j.data&&j.data.user&&j.data.user.role)+' hasToken='+!!(j.data&&j.data.token))))
  .catch(e=>out('ERR '+e.message));
setTimeout(()=>out('done'), 1500);
