{
  'conditions': [
    ['OS=="mac"', {
      "targets": [
        {
            "target_name": "automation",
            "sources": ["src/automation_mac.mm"],
            "xcode_settings": {
                "MACOSX_DEPLOYMENT_TARGET": "10.14",
                "OTHER_LDFLAGS": ["-framework Cocoa"]
            }
        }
      ]
    }],
    ['OS!="mac"', {
      "targets": [
        {
            "target_name": "dummy"
        }
      ]
    }]
  ]
}
