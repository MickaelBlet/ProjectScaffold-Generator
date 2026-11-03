//! Windows: embed version information and an application manifest into scaffold-gen.exe
//! (file properties, and fewer antivirus false positives than a bare executable).

use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let version = env::var("CARGO_PKG_VERSION").unwrap();
    let numbers: Vec<u16> = version
        .split(['.', '-', '+'])
        .take(3)
        .map(|n| n.parse().unwrap_or(0))
        .chain([0; 4])
        .take(4)
        .collect();
    let comma = numbers.iter().map(u16::to_string).collect::<Vec<_>>().join(",");
    let description = env::var("CARGO_PKG_DESCRIPTION").unwrap();
    let company = env::var("CARGO_PKG_AUTHORS").unwrap();

    fs::write(out.join("scaffold-gen.manifest"), MANIFEST.replace("{version}", &comma.replace(',', ".")))
        .unwrap();
    // Numeric constants instead of <winver.h>: no SDK headers needed when cross compiling.
    let rc = format!(
        r#"#pragma code_page(65001)
1 24 "scaffold-gen.manifest"
1 VERSIONINFO
FILEVERSION {comma}
PRODUCTVERSION {comma}
FILEFLAGSMASK 0x3F
FILEFLAGS 0
FILEOS 0x40004
FILETYPE 1
FILESUBTYPE 0
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "{company}"
      VALUE "FileDescription", "{description}"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "scaffold-gen"
      VALUE "LegalCopyright", "Copyright (c) 2026 {company}. MIT License."
      VALUE "OriginalFilename", "scaffold-gen.exe"
      VALUE "ProductName", "ProjectScaffold-Generator"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#
    );
    let rc_path = out.join("scaffold-gen.rc");
    fs::write(&rc_path, rc).unwrap();
    embed_resource::compile(&rc_path, embed_resource::NONE).manifest_required().unwrap();
}

const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="ProjectScaffold.scaffold-gen" version="{version}"/>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
    </windowsSettings>
  </application>
</assembly>
"#;
