use std::env;

// WebGL stealth: SwiftShader is common in virtualized Linux environments and can trip
// bot-detection checks. When SwiftShader is detected, the injected script spoofs the
// WebGL vendor/renderer values in page scripts.
//
// Enabled by default; disable with AGENT_BROWSER_STEALTH_WEBGL=0/false/no.
pub fn webgl_stealth_enabled() -> bool {
    match env::var("AGENT_BROWSER_STEALTH_WEBGL") {
        Ok(val) => !matches!(val.to_lowercase().as_str(), "0" | "false" | "no" | ""),
        Err(_) => true, // default to enabled
    }
}

pub const WEBGL_STEALTH_INIT_SCRIPT: &str = r#"(() => {
  const UNMASKED_VENDOR_WEBGL = 37445;
  const UNMASKED_RENDERER_WEBGL = 37446;

  const SPOOF_VENDOR = 'Intel Inc.';
  const SPOOF_RENDERER = 'Intel Iris OpenGL Engine';

  const shouldSpoof = (getParameter, ctx) => {
    try {
      const renderer = getParameter.call(ctx, UNMASKED_RENDERER_WEBGL);
      return typeof renderer === 'string' && renderer.includes('SwiftShader');
    } catch {
      return false;
    }
  };

  const patchPrototype = (proto) => {
    if (!proto || typeof proto.getParameter !== 'function') return;
    const originalGetParameter = proto.getParameter;
    proto.getParameter = function(parameter) {
      const value = originalGetParameter.apply(this, arguments);
      if (
        parameter !== UNMASKED_VENDOR_WEBGL &&
        parameter !== UNMASKED_RENDERER_WEBGL
      ) {
        return value;
      }

      if (!shouldSpoof(originalGetParameter, this)) {
        return value;
      }

      if (parameter === UNMASKED_VENDOR_WEBGL) return SPOOF_VENDOR;
      if (parameter === UNMASKED_RENDERER_WEBGL) return SPOOF_RENDERER;
      return value;
    };
  };

  try {
    patchPrototype(globalThis.WebGLRenderingContext && globalThis.WebGLRenderingContext.prototype);
    patchPrototype(globalThis.WebGL2RenderingContext && globalThis.WebGL2RenderingContext.prototype);
  } catch {
    // ignore
  }
})();"#;
