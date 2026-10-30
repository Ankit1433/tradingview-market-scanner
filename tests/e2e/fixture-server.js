const {setupEnv,fixture}=require('../support/appFixture');
const fs=require('fs');setupEnv('ankquant-playwright-');
fixture().then(app=>{fs.writeFileSync(process.env.PLAYWRIGHT_URL_FILE,app.base);console.log('Fixture server ready');let stopping=false;async function stop(){if(stopping)return;stopping=true;await app.close();process.exit(0);}process.on('SIGTERM',stop);process.on('SIGINT',stop);}).catch(()=>{console.error('Fixture startup failed');process.exit(1);});
