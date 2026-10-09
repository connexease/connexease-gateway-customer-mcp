import { spawn } from 'node:child_process';
import { runWindowsNative } from './windows-native.mjs';

// The action details travel through stdin, not process arguments or the AI prompt.
const CONFIRM_SCRIPT = 'ObjC.import("Foundation"); var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile; var payload = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding))); var app = Application.currentApplication(); app.includeStandardAdditions = true; var answer = app.displayDialog(payload.prompt, {defaultAnswer: payload.value, buttons: ["Cancel", payload.approveLabel], defaultButton: "Cancel", cancelButton: "Cancel"}); answer.buttonReturned === payload.approveLabel && answer.textReturned === payload.value ? "CONFIRMED" : "CANCELLED";';

export function runNativeConfirmation(payload, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('/usr/bin/osascript', ['-l', 'JavaScript', '-e', CONFIRM_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.resume();
    child.on('error', () => reject(new Error('macOS confirmation dialog is unavailable')));
    child.on('close', (code) => {
      if (code === 0) resolve(output.trim() === 'CONFIRMED');
      else if (code === 1) resolve(false);
      else reject(new Error('macOS confirmation dialog is unavailable'));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function runWindowsConfirmation(payload, native = runWindowsNative) {
  return (await native('confirm', payload)) === true;
}

function confirmationExecutor(execute, platform, windowsNative) {
  if (execute) return execute;
  if (platform === 'darwin') return runNativeConfirmation;
  if (platform === 'win32') return (payload) => runWindowsConfirmation(payload, windowsNative ?? runWindowsNative);
  throw new Error('Gateway actions require macOS or Windows native confirmation');
}

export async function confirmGatewayAction(action, { execute, platform = process.platform, windowsNative } = {}) {
  const confirm = confirmationExecutor(execute, platform, windowsNative);
  if (action.kind === 'add_test_number') {
    const { applicationId, phoneNumber, title } = action.preview;
    return confirm({
      prompt: `Add a REAL sandbox test number?\nApplication: ${applicationId}\nLabel: ${title ?? '(default)'}\nOnly add a number you are authorized to message. Review the phone number below and click Add to save it.`,
      value: phoneNumber,
      approveLabel: 'Add',
    });
  }
  if (action.kind === 'send_sandbox_text') {
    const { applicationId, phoneNumber, testNumber, message } = action.preview;
    const safeLabel = String(testNumber).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 100);
    return confirm({
      prompt: `Send ONE REAL sandbox WhatsApp message?\nApplication: ${applicationId}\nRecipient: ${safeLabel} (${phoneNumber})\nReview the exact message below. Send makes one request; delivery is not guaranteed. Do not retry an uncertain result without checking sandbox history.`,
      value: message,
      approveLabel: 'Send',
    });
  }
  if (action.kind === 'send_sandbox_template') {
    const { applicationId, phoneNumber, testNumber, template, parameters } = action.preview;
    const safeLabel = String(testNumber).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 100);
    const safeTemplateName = String(template.name).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 100);
    const review = JSON.stringify({
      templateId: template.id,
      sourceId: template.sourceId,
      name: template.name,
      language: template.language,
      category: template.category,
      components: template.components,
      parameters,
    }, null, 2);
    return confirm({
      prompt: `Send ONE REAL sandbox WhatsApp TEMPLATE message?\nApplication: ${applicationId}\nRecipient: ${safeLabel} (${phoneNumber})\nTemplate: ${safeTemplateName} (${template.language})\nReview the exact template and parameters below. Send makes one request; delivery is not guaranteed.`,
      value: review,
      approveLabel: 'Send',
    });
  }
  if (action.kind === 'panel_action') {
    const review = JSON.stringify(action.preview.details, null, 2);
    const safeAction = String(action.preview.action).replace(/[^a-z_]/g, '').slice(0, 60);
    return confirm({
      prompt: `Perform ONE REAL Gateway panel action: ${safeAction}?\nReview the exact before/after details below. This changes your live account. An uncertain result must be checked in the panel before any retry.`,
      value: review,
      approveLabel: 'Apply',
    });
  }
  throw new Error('Unknown Gateway confirmation action');
}

/** Show a newly created credential locally; never put its value in an MCP result. */
export async function showGatewaySecret({ label, secret }, { execute, platform = process.platform, windowsNative } = {}) {
  const confirm = confirmationExecutor(execute, platform, windowsNative);
  return confirm({
    prompt: `${String(label).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 100)} was created. Copy the secret below now. Do not paste it into any AI chat or issue. You can also manage this credential in Gateway panel.`,
    value: secret,
    approveLabel: 'Done',
  });
}
