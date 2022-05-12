#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#include <node_api.h>
#import <Cocoa/Cocoa.h>
#import <libproc.h>


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

  status = napi_create_string_utf8(env, [windowInfo[(id)kCGWindowName] UTF8String], NAPI_AUTO_LENGTH, &v);
  assert(status == napi_ok);
  status = napi_set_named_property(env, ret, "title", v);
  assert(status == napi_ok);

  status = napi_create_string_utf8(env, [windowInfo[(id)kCGWindowOwnerName] UTF8String], NAPI_AUTO_LENGTH, &v);
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
  if (bounds != NULL) {
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
  status = napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  assert(status == napi_ok);

  if (argc < 1) {
    napi_throw_type_error(env, NULL, "Wrong number of arguments");
    return NULL;
  }

  napi_valuetype valuetype0;
  status = napi_typeof(env, args[0], &valuetype0);
  assert(status == napi_ok);
  if (valuetype0 != napi_number) {
    napi_throw_type_error(env, NULL, "Wrong argument type");
    return NULL;
  }

  int32_t windowId;
  status = napi_get_value_int32(env, args[0], &windowId);
  assert(status == napi_ok);
  // NSLog(@"window Id %d ", windowId);

  NSMutableArray *windows = (NSMutableArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, windowId);

  napi_value ret = NULL;
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
  NSMutableArray *windows = (NSMutableArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
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

bool activate_window_of_id(uint32_t wid) {
  bool success = false;
  const CGWindowLevel kScreensaverWindowLevel = CGWindowLevelForKey(kCGScreenSaverWindowLevelKey);

  NSMutableArray *windows = (NSMutableArray *)CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, wid);
  for (NSDictionary *windowInfo in windows) {
    if ([windowInfo[(id)kCGWindowNumber] integerValue] != wid) {
      continue;
    }
    NSNumber *level = (NSNumber *)(windowInfo[(id)kCGWindowLayer]);
    if (level.integerValue >= kScreensaverWindowLevel) {
      break;
    }

    // https://stackoverflow.com/questions/47066205/macos-activate-a-window-given-its-window-id
    NSDictionary *windowInfoDictionary = windowInfo;
    NSNumber *ownerPID = (NSNumber *)(windowInfoDictionary[(id)kCGWindowOwnerPID]);
    NSNumber *windowID = windowInfoDictionary[(id)kCGWindowNumber];
    CFIndex appCount = [[[NSWorkspace sharedWorkspace] runningApplications] count];
    for (CFIndex j = 0; j < appCount; j++) {
      if (ownerPID.integerValue == [[[[NSWorkspace sharedWorkspace] runningApplications] objectAtIndex:j] processIdentifier]) {
        NSRunningApplication *appWithPID = [[[NSWorkspace sharedWorkspace] runningApplications] objectAtIndex:j];
        [appWithPID activateWithOptions:NSApplicationActivateAllWindows | NSApplicationActivateIgnoringOtherApps];
        char buf[PROC_PIDPATHINFO_MAXSIZE];
        proc_pidpath(ownerPID.integerValue, buf, sizeof(buf));
        NSString *buffer = [NSString stringWithUTF8String:buf];
        unsigned long location = [buffer rangeOfString:@".app/Contents/MacOS/" options:NSBackwardsSearch].location;
        NSString *path = (location != NSNotFound) ? [buffer substringWithRange:NSMakeRange(0, location)] : buffer;
        NSString *app = [@" of application \\\"" stringByAppendingString:[path lastPathComponent]];
        NSString *index = [@"set index of window id " stringByAppendingString:[windowID stringValue]];
        NSString *execScript = [[index stringByAppendingString:app] stringByAppendingString:@"\\\" to 1"];
        char *pointer = NULL;
        size_t buffer_size = 0;
        NSMutableArray *array = [[NSMutableArray alloc] init];
        FILE *file = popen([[[@"osascript -e \"" stringByAppendingString:execScript] stringByAppendingString:@"\" 2>&1"] UTF8String], "r");
        while (getline(&pointer, &buffer_size, file) != -1)
          [array addObject:[NSString stringWithUTF8String:pointer]];
        char *error = (char *)[[array componentsJoinedByString:@""] UTF8String];
        if (strlen(error) > 0 && error[strlen(error) - 1] == '\n')
          error[strlen(error) - 1] = '\0';
        if ([[NSString stringWithUTF8String:error] isEqualToString:@""])
          success = true;
        [array release];
        free(pointer);
        pclose(file);
        break;
      }
    }
  }

  CFRelease(windows);
  return success;
}

static napi_value setActiveWindow(napi_env env, napi_callback_info info) {
  napi_status status;

  size_t argc = 1;
  napi_value args[1];
  status = napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  assert(status == napi_ok);

  if (argc < 1) {
    napi_throw_type_error(env, NULL, "Wrong number of arguments");
    return NULL;
  }

  napi_valuetype valuetype0;
  status = napi_typeof(env, args[0], &valuetype0);
  assert(status == napi_ok);
  if (valuetype0 != napi_number) {
    napi_throw_type_error(env, NULL, "Wrong argument type");
    return NULL;
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

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    { "getWindowInfo", 0, getWindowInfo, 0, 0, 0, napi_default, 0 },
    { "getWindows", 0, getWindows, 0, 0, 0, napi_default, 0 },
    { "setActiveWindow", 0, setActiveWindow, 0, 0, 0, napi_default, 0 },
  };
  napi_status status = napi_define_properties(env, exports, 3, properties);
  assert(status == napi_ok);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
