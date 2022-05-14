{
  'conditions': [
    ['OS=="mac"', {
      "targets": [
        {
            "target_name": "karakuri",
            "sources": ["src/automation.mm"],
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
