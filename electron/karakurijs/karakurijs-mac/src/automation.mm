#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <libproc.h>
#include <node_api.h>

static napi_value make_window_info(napi_env env, NSDictionary *windowInfo) {
  napi_status status;
  napi_value ret;
  status = napi_create_object(env, &ret);
  assert(status == napi_ok);
  napi_value v;

  status = napi_create_int32(env, [windowInfo[(id)kCGWindowNumber] integerValue], &v);
  assert(status == napi_ok);
  status = napi_set_named_property(env, ret, "id", v);
  assert(status == napi_ok);

  status = napi_create_string_utf8(env, [windowInfo[(id)kCGWindowName] UTF8String],
                                   NAPI_AUTO_LENGTH, &v);
  assert(status == napi_ok);
  status = napi_set_named_property(env, ret, "title", v);
  assert(status == napi_ok);

  status = napi_create_string_utf8(env, [windowInfo[(id)kCGWindowOwnerName] UTF8String],
                                   NAPI_AUTO_LENGTH, &v);
  assert(status == napi_ok);
  status = napi_set_named_property(env, ret, "app", v);
  assert(status == napi_ok);

  status = napi_create_int32(env, [windowInfo[(id)kCGWindowOwnerPID] integerValue], &v);
  assert(status == napi_ok);
  status = napi_set_named_property(env, ret, "pid", v);
  assert(status == napi_ok);

  status = napi_create_int32(env, [windowInfo[(id)kCGWindowLayer] integerValue], &v);
  assert(status == napi_ok);
  status = napi_set_named_property(env, ret, "layer", v);
  assert(status == napi_ok);

  NSDictionary *bounds = windowInfo[(id)kCGWindowBounds];
  if (bounds != nullptr) {
    napi_value boundsObj;
    status = napi_create_object(env, &boundsObj);
    assert(status == napi_ok);
    status = napi_set_named_property(env, ret, "bounds", boundsObj);
    assert(status == napi_ok);

    status = napi_create_int32(env, [[bounds objectForKey:@"X"] integerValue], &v);
    assert(status == napi_ok);
    status = napi_set_named_property(env, boundsObj, "x", v);
    assert(status == napi_ok);

    status = napi_create_int32(env, [[bounds objectForKey:@"Y"] integerValue], &v);
    assert(status == napi_ok);
    status = napi_set_named_property(env, boundsObj, "y", v);
    assert(status == napi_ok);

    status = napi_create_int32(env, [[bounds objectForKey:@"Width"] integerValue], &v);
    assert(status == napi_ok);
    status = napi_set_named_property(env, boundsObj, "width", v);
    assert(status == napi_ok);

    status = napi_create_int32(env, [[bounds objectForKey:@"Height"] integerValue], &v);
    assert(status == napi_ok);
    status = napi_set_named_property(env, boundsObj, "height", v);
    assert(status == napi_ok);
  }

  return ret;
}

static napi_value getWindowInfo(napi_env env, napi_callback_info info) {
  napi_status status;

  size_t argc = 1;
  napi_value args[1];
  status = napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  assert(status == napi_ok);

  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "Wrong number of arguments");
    return nullptr;
  }

  napi_valuetype valuetype0;
  status = napi_typeof(env, args[0], &valuetype0);
  assert(status == napi_ok);
  if (valuetype0 != napi_number) {
    napi_throw_type_error(env, nullptr, "Wrong argument type");
    return nullptr;
  }

  int32_t windowId;
  status = napi_get_value_int32(env, args[0], &windowId);
  assert(status == napi_ok);
  // NSLog(@"window Id %d ", windowId);

  NSMutableArray *windows =
      (NSMutableArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, windowId);

  napi_value ret = nullptr;
  for (NSDictionary *windowInfo in windows) {
    if ([windowInfo[(id)kCGWindowNumber] integerValue] == windowId) {
      ret = make_window_info(env, windowInfo);
      break;
    }
  }

  CFRelease(windows);
  return ret;
}

static napi_value getWindows(napi_env env, napi_callback_info info) {
  NSMutableArray *windows = (NSMutableArray *)CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  if (windows == nullptr) {
    return nullptr;
  }

  napi_status status;
  napi_value ret;
  status = napi_create_array(env, &ret);
  assert(status == napi_ok);

  uint32_t idx = 0;
  for (NSDictionary *windowInfo in windows) {
    status = napi_set_element(env, ret, idx++, make_window_info(env, windowInfo));
    assert(status == napi_ok);
  }

  CFRelease(windows);
  return ret;
}

// https://stackoverflow.com/questions/6178860/getting-window-number-through-osx-accessibility-api
extern "C" AXError _AXUIElementGetWindow(AXUIElementRef, CGWindowID *out);

bool activate_window_of_id(uint32_t wid) {
  bool success = false;
  const CGWindowLevel kScreensaverWindowLevel = CGWindowLevelForKey(kCGScreenSaverWindowLevelKey);

  NSMutableArray *windows =
      (NSMutableArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, wid);
  for (NSDictionary *windowInfo in windows) {
    if ([windowInfo[(id)kCGWindowNumber] integerValue] != wid) {
      continue;
    }
    int layer = [windowInfo[(id)kCGWindowLayer] integerValue];
    if (layer >= kScreensaverWindowLevel) {
      break;
    }
    int pid = [windowInfo[(id)kCGWindowOwnerPID] integerValue];

    NSRunningApplication *nsapp =
        [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (nsapp) {
      [nsapp activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    }

    AXUIElementRef app = AXUIElementCreateApplication(pid);
    if (!app) {
      continue;
    }

    CFArrayRef array;
    AXUIElementCopyAttributeValues(app, kAXWindowsAttribute, 0, 99999, &array);
    if (array != nullptr) {
      NSArray *windows = (NSArray *)CFBridgingRelease(array);
      for (NSUInteger i = 0; i < windows.count; ++i) {
        AXUIElementRef win = (__bridge AXUIElementRef)(windows[i]);
        CGWindowID windowID;
        _AXUIElementGetWindow(win, &windowID);

        if (windowID == wid) {
          success = AXUIElementPerformAction(win, kAXRaiseAction) == 0;
          break;
        }
      }
    }

    CFRelease(app);
  }

  CFRelease(windows);
  return success;
}

static napi_value setActiveWindow(napi_env env, napi_callback_info info) {
  napi_status status;

  size_t argc = 1;
  napi_value args[1];
  status = napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  assert(status == napi_ok);

  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "Wrong number of arguments");
    return nullptr;
  }

  napi_valuetype valuetype0;
  status = napi_typeof(env, args[0], &valuetype0);
  assert(status == napi_ok);
  if (valuetype0 != napi_number) {
    napi_throw_type_error(env, nullptr, "Wrong argument type");
    return nullptr;
  }

  int32_t windowId;
  status = napi_get_value_int32(env, args[0], &windowId);
  assert(status == napi_ok);
  // NSLog(@"window Id %d ", windowId);

  bool success = activate_window_of_id(windowId);

  napi_value ret;
  status = napi_get_boolean(env, success, &ret);
  assert(status == napi_ok);
  return ret;
}

static napi_value getMousePos(napi_env env, napi_callback_info info) {
  napi_status status;

  CGEventRef event = CGEventCreate(nullptr);
  CGPoint point = CGEventGetLocation(event);
  CFRelease(event);

  napi_value v;
  napi_value ret;
  status = napi_create_object(env, &ret);
  assert(status == napi_ok);

  status = napi_create_int32(env, (int32_t)point.x, &v);
  assert(status == napi_ok);
  status = napi_set_named_property(env, ret, "x", v);
  assert(status == napi_ok);

  status = napi_create_int32(env, (int32_t)point.y, &v);
  assert(status == napi_ok);
  status = napi_set_named_property(env, ret, "y", v);
  assert(status == napi_ok);

  return ret;
}

static napi_value setMousePos(napi_env env, napi_callback_info info) {
  napi_status status;

  size_t argc = 2;
  napi_value args[2];
  status = napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  assert(status == napi_ok);

  if (argc < 2) {
    napi_throw_type_error(env, nullptr, "Wrong number of arguments");
    return nullptr;
  }

  int32_t px;
  status = napi_get_value_int32(env, args[0], &px);
  assert(status == napi_ok);

  int32_t py;
  status = napi_get_value_int32(env, args[1], &py);
  assert(status == napi_ok);

  CGPoint point = CGPointMake(px, py);

  CGEventRef event0 = CGEventCreate(nullptr);
  CGPoint point0 = CGEventGetLocation(event0);
  CFRelease(event0);

  CGEventRef event =
      CGEventCreateMouseEvent(nullptr, kCGEventMouseMoved, point, kCGMouseButtonLeft);

  CGEventSetIntegerValueField(event, kCGMouseEventDeltaX, point.x - point0.x);
  CGEventSetIntegerValueField(event, kCGMouseEventDeltaY, point.y - point0.y);

  CGEventPost(kCGSessionEventTap, event);
  CFRelease(event);

  return nullptr;
}

static napi_value toggleMouseButton(napi_env env, napi_callback_info info) {
  napi_status status;

  size_t argc = 2;
  napi_value args[2];
  status = napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  assert(status == napi_ok);

  if (argc < 2) {
    napi_throw_type_error(env, nullptr, "Wrong number of arguments");
    return nullptr;
  }

  int32_t button;
  status = napi_get_value_int32(env, args[0], &button);
  assert(status == napi_ok);

  int32_t down;
  status = napi_get_value_int32(env, args[1], &down);
  assert(status == napi_ok);

  CGEventRef event0 = CGEventCreate(nullptr);
  CGPoint point0 = CGEventGetLocation(event0);
  CFRelease(event0);

  CGEventType mtype;
  CGMouseButton mbutton;
  switch (button) {
    case 0:
      mbutton = kCGMouseButtonLeft;
      mtype = down != 0 ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
      break;
    case 1:
      mbutton = kCGMouseButtonCenter;
      mtype = down != 0 ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
      break;
    default:
      mbutton = kCGMouseButtonRight;
      mtype = down != 0 ? kCGEventRightMouseDown : kCGEventRightMouseUp;
  }
  CGEventRef event = CGEventCreateMouseEvent(nullptr, mtype, point0, mbutton);

  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);

  return nullptr;
}

static napi_value isProcessTrusted(napi_env env, napi_callback_info info) {
  napi_status status;
  bool trusted = false;

  if (@available(macOS 10.9, *)) {
    NSDictionary *options = @{(id)kAXTrustedCheckOptionPrompt : @YES};
    trusted = AXIsProcessTrustedWithOptions((CFDictionaryRef)options);
  } else {
    trusted = AXIsProcessTrusted();
  }
  napi_value ret;
  status = napi_get_boolean(env, trusted, &ret);
  assert(status == napi_ok);
  return ret;
}

static napi_value hasScreenCaptureAccess(napi_env env, napi_callback_info info) {
  napi_status status;
  bool success = true;

  if (@available(macOS 11.0, *)) {
    success = CGPreflightScreenCaptureAccess();
  } else if (@available(macOS 10.15, *)) {
    success = false;  // TODO
  }
  napi_value ret;
  status = napi_get_boolean(env, success, &ret);
  assert(status == napi_ok);
  return ret;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"getWindowInfo", 0, getWindowInfo, 0, 0, 0, napi_default, 0},
      {"getWindows", 0, getWindows, 0, 0, 0, napi_default, 0},
      {"setActiveWindow", 0, setActiveWindow, 0, 0, 0, napi_default, 0},
      {"getMousePos", 0, getMousePos, 0, 0, 0, napi_default, 0},
      {"setMousePos", 0, setMousePos, 0, 0, 0, napi_default, 0},
      {"toggleMouseButton", 0, toggleMouseButton, 0, 0, 0, napi_default, 0},
      {"isProcessTrusted", 0, isProcessTrusted, 0, 0, 0, napi_default, 0},
      {"hasScreenCaptureAccess", 0, hasScreenCaptureAccess, 0, 0, 0, napi_default, 0},
  };
  napi_status status = napi_define_properties(
      env, exports, sizeof(properties) / sizeof(napi_property_descriptor), properties);
  assert(status == napi_ok);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
