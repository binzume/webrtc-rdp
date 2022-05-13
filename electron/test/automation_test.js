// bash -c "TEST_MODE=1 ELECTRON_RUN_AS_NODE=1 electron test/automation_test.js"

const automation = require('../automation');


let pos = automation.getMousePos();
console.log(pos);
let wid = automation.windowFromPoint(pos.x, pos.y);
console.log(wid);
let info = automation.getWindowInfo(wid);
console.log(info);
automation.setForegroundWindow(wid);

console.log(automation.getDisplays());

automation.click(0);

automation.tapKey('a');
automation.tapKey('!');
automation.tapKey('あ');
automation.tapKey('A', ['control']);
