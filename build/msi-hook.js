const fs = require('fs');
const path = require('path');

exports.default = async function(wxsFilePath) {
  console.log('MSI Hook: Called with path:', wxsFilePath);

  const wxsFile = typeof wxsFilePath === 'string' ? wxsFilePath : wxsFilePath?.wxsFile || wxsFilePath?.path;
  
  if (!wxsFile || !fs.existsSync(wxsFile)) {
    console.warn('MSI Hook: Could not find .wxs file, path:', wxsFile);
    return;
  }
  
  console.log('MSI Hook: Processing', wxsFile);
  let content = fs.readFileSync(wxsFile, 'utf8');
  const licenseFile = path.join(__dirname, 'msi-license.rtf');
  
  if (!fs.existsSync(licenseFile)) {
    console.warn('MSI Hook: License file not found at', licenseFile);
    return;
  }

  const licenseVarTag = `<WixVariable Id="WixUILicenseRtf" Value="${licenseFile.replace(/\\/g, '/')}" />`;
  
  if (!content.includes('WixUILicenseRtf')) {
    content = content.replace(
      /(<UIRef\s+Id="WixUI_InstallDir"\s*\/>)/i,
      licenseVarTag + '\n      $1'
    );
    console.log('MSI Hook: Added WixUILicenseRtf variable');
  }

  const welcomeSkipRemoved = content.replace(
    /<Publish\s+Dialog="WelcomeDlg"\s+Control="Next"\s+Event="NewDialog"\s+Value="InstallScopeDlg"[^>]*>[^<]*<\/Publish>\s*/gi,
    ''
  );
  if (welcomeSkipRemoved !== content) {
    content = welcomeSkipRemoved;
    console.log('MSI Hook: Removed WelcomeDlg->InstallScopeDlg skip');
  }

  const licenseNavRules = `
        <!-- License dialog navigation added by msi-hook -->
        <Publish Dialog="LicenseAgreementDlg" Control="Next" Event="NewDialog" Value="InstallScopeDlg" Order="3">LicenseAccepted = "1"</Publish>
        <Publish Dialog="InstallScopeDlg" Control="Back" Event="NewDialog" Value="LicenseAgreementDlg" Order="2">1</Publish>`;

  if (!content.includes('Dialog="LicenseAgreementDlg" Control="Next"')) {
    content = content.replace(
      /(<Publish\s+Dialog="WelcomeDlg"\s+Control="Next"\s+Event="SpawnWaitDialog"[^>]*>[^<]*<\/Publish>)/i,
      '$1' + licenseNavRules
    );
    console.log('MSI Hook: Added LicenseAgreementDlg->InstallScopeDlg navigation');
  }

  const msiMarkerComponent = `
    <!-- MSI Installation marker - disables in-app auto-updates -->
    <Component Id="MsiInstallMarker" Guid="A1B2C3D4-E5F6-7890-ABCD-EF1234567890">
      <RegistryKey Root="HKCU" Key="Software\\IYERIS">
        <RegistryValue Name="InstalledViaMsi" Type="integer" Value="1" KeyPath="yes"/>
      </RegistryKey>
    </Component>`;

  if (!content.includes('MsiInstallMarker')) {
    content = content.replace(
      /(<ComponentGroup\s+Id="ProductComponents"[^>]*>)/i,
      '$1' + msiMarkerComponent
    );
    
    console.log('MSI Hook: Added MSI installation marker registry component');
  }

  fs.writeFileSync(wxsFile, content, 'utf8');
  console.log('MSI Hook: Modifications complete');

  const debugFile = wxsFile + '.modified.txt';
  fs.writeFileSync(debugFile, content, 'utf8');
  console.log('MSI Hook: Debug copy saved to', debugFile);
};
