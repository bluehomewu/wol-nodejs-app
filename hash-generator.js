// hash-generator.js
const bcrypt = require('bcrypt');

// 從命令列參數讀取您要加密的密碼
const plainTextPassword = process.argv[2];

if (!plainTextPassword) {
    console.error('請提供一個密碼作為參數！');
    console.log('用法: node hash-generator.js "您的密碼"');
    process.exit(1);
}

// 'salt rounds' - 數值越高越安全，但耗時越長。10-12 是推薦值。
const saltRounds = 12;

console.log('正在為您的密碼產生雜湊值，請稍候...');

bcrypt.hash(plainTextPassword, saltRounds, (err, hash) => {
    if (err) {
        console.error('產生雜湊時發生錯誤:', err);
        return;
    }
    console.log('\n您的密碼雜湊值是：');
    console.log('------------------------------------------------------------');
    console.log(hash);
    console.log('------------------------------------------------------------');
    console.log('\n請將此完整的雜湊值複製到您的 config.json 檔案中。');
});
