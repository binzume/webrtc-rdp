// Run test on electron:
// bash -c "TEST_MODE=1 ELECTRON_RUN_AS_NODE=1 electron karakurijs/test/karakurijs_test.js"

const karakuri = require('karakurijs');

let pos = karakuri.getMousePos();
console.log(pos);
let wid = karakuri.windowFromPoint(pos.x, pos.y);
console.log(wid);
let info = karakuri.getWindowInfo(wid);
console.log(info);
karakuri.setForegroundWindow(wid);

karakuri.click();

karakuri.tapKey('a');
karakuri.tapKey('!');
karakuri.tapKey('あ');

if (process.platform == 'darwin') {
    karakuri.tapKey('a', ['Command']);
} else {
    karakuri.tapKey('a', ['Control']);
}
