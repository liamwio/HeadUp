package com.headup.growth;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import org.json.JSONObject;

/** A separate, origin-bound WebView. No Capacitor or general JavaScript interface is exposed to the server. */
public class FamilyServerActivity extends AppCompatActivity {
    private WebView web;
    private String origin, downloadScript;
    private TextView status;
    private ExportController exporter;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest cameraRequest;
    private ActivityResultLauncher<Intent> filePicker;
    private ActivityResultLauncher<String> cameraPermission;
    private int pageEpoch;
    private boolean destroyed, failedMainLoad;
    private boolean sameOrigin(String value) {
        try { Uri uri=Uri.parse(value); return origin.equals(ServerAddress.normalize(uri.getScheme()+"://"+uri.getEncodedAuthority())); }
        catch (Exception error) { return false; }
    }
    @SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        try { origin=ServerAddress.normalize(getIntent().getStringExtra("origin")); }
        catch(Exception error) { finish(); return; }
        exporter=new ExportController(this);
        filePicker=registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            ValueCallback<Uri[]> callback=fileCallback;fileCallback=null;if(callback==null)return;
            if(result.getResultCode()!=RESULT_OK||result.getData()==null){callback.onReceiveValue(null);return;}
            Intent data=result.getData();ArrayList<Uri> uris=new ArrayList<>();
            if(data.getClipData()!=null)for(int i=0;i<data.getClipData().getItemCount();i++)uris.add(data.getClipData().getItemAt(i).getUri());
            else if(data.getData()!=null)uris.add(data.getData());
            callback.onReceiveValue(uris.toArray(new Uri[0]));
        });
        cameraPermission=registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            PermissionRequest request=cameraRequest;cameraRequest=null;if(request==null)return;
            if(granted&&!destroyed&&sameOrigin(request.getOrigin().toString()))request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});else request.deny();
        });
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(Color.rgb(120,45,62));
        ViewCompat.setOnApplyWindowInsetsListener(root,(view,insets)->{androidx.core.graphics.Insets bars=insets.getInsets(WindowInsetsCompat.Type.systemBars()|WindowInsetsCompat.Type.ime());view.setPadding(bars.left,bars.top,bars.right,bars.bottom);return insets;});
        LinearLayout bar=new LinearLayout(this);bar.setGravity(android.view.Gravity.CENTER_VERTICAL);
        Button close=new Button(this);close.setText("返回本机");close.setOnClickListener(v->confirmClose());bar.addView(close);
        TextView label=new TextView(this);label.setText(origin);label.setTextColor(Color.WHITE);label.setTextSize(12);bar.addView(label,new LinearLayout.LayoutParams(0,-2,1));
        Button reload=new Button(this);reload.setText("刷新");reload.setOnClickListener(v->confirmLeave(()->web.reload()));bar.addView(reload);root.addView(bar);
        status=new TextView(this);status.setText("正在连接家庭服务器…");status.setTextColor(Color.WHITE);status.setPadding(12,6,12,6);root.addView(status);
        web=new WebView(this);root.addView(web,new LinearLayout.LayoutParams(-1,0,1));setContentView(root);
        WebSettings settings=web.getSettings();settings.setUserAgentString(settings.getUserAgentString()+" HeadUpAndroid/1.0");settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);settings.setAllowFileAccess(false);settings.setAllowContentAccess(true);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setMediaPlaybackRequiresUserGesture(true);settings.setSupportMultipleWindows(false);settings.setJavaScriptCanOpenWindowsAutomatically(false);
        CookieManager.getInstance().setAcceptCookie(true);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        try(java.io.InputStream source=getAssets().open("native-download.js");java.io.ByteArrayOutputStream buffer=new java.io.ByteArrayOutputStream()){byte[] chunk=new byte[8192];int n;while((n=source.read(chunk))!=-1)buffer.write(chunk,0,n);downloadScript=new String(buffer.toByteArray(),StandardCharsets.UTF_8);}catch(Exception ignored){downloadScript="";}
        if(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))WebViewCompat.addWebMessageListener(web,"HeadUpExport",Collections.singleton(origin),(view,message,sourceOrigin,isMainFrame,proxy)->{
            if(!isMainFrame||destroyed||!sameOrigin(sourceOrigin.toString()))return;
            try{
                String text=message.getData();if(text==null||text.length()>310000)return;
                JSONObject data=new JSONObject(text);String id=data.optString("id");if(id.length()>100)return;int epoch=pageEpoch;
                ExportController.Reply reply=new ExportController.Reply(){public void resolve(JSObject value){runOnUiThread(()->{if(!destroyed&&epoch==pageEpoch&&WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))proxy.postMessage(new JSObject().put("id",id).put("result",value).toString());});}public void reject(String error){runOnUiThread(()->{if(!destroyed&&epoch==pageEpoch&&WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER))proxy.postMessage(new JSObject().put("id",id).put("error",error).toString());});}};
                switch(data.optString("action")){
                    case "begin": exporter.begin(data.optString("name"),data.optString("mime"),data.optLong("size",-1),reply);break;
                    case "append": exporter.append(data.optString("token"),data.optString("data"),reply);break;
                    case "finish": exporter.finish(data.optString("token"),reply);break;
                    case "abort": exporter.abort(data.optString("token"));reply.resolve(new JSObject());break;
                    default: reply.reject("不支持的文件操作");
                }
            }catch(Exception ignored){ /* Do not log personal file contents. */ }
        });
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
                if(sameOrigin(request.getUrl().toString()))return false;
                String scheme=request.getUrl().getScheme();
                if(request.hasGesture()&&("https".equals(scheme)||"mailto".equals(scheme)))try{startActivity(new Intent(Intent.ACTION_VIEW,request.getUrl()));}catch(Exception ignored){}
                return true;
            }
            @Override public void onPageStarted(WebView view,String url,android.graphics.Bitmap favicon){pageEpoch++;failedMainLoad=false;exporter.reset();if(cameraRequest!=null){cameraRequest.deny();cameraRequest=null;}if(fileCallback!=null){fileCallback.onReceiveValue(null);fileCallback=null;}status.setVisibility(android.view.View.VISIBLE);status.setText("正在连接家庭服务器…");}
            @Override public void onPageFinished(WebView view,String url){if(sameOrigin(url)&&!failedMainLoad){status.setVisibility(android.view.View.GONE);if(!downloadScript.isEmpty())view.evaluateJavascript(downloadScript,null);}CookieManager.getInstance().flush();}
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){if(request.isForMainFrame()){failedMainLoad=true;status.setVisibility(android.view.View.VISIBLE);status.setText("服务器暂不可用，请检查网络或地址后刷新。本机模式可离线使用。");}}
            @Override public void onReceivedSslError(WebView view,android.webkit.SslErrorHandler handler,android.net.http.SslError error){handler.cancel();failedMainLoad=true;status.setVisibility(android.view.View.VISIBLE);status.setText("服务器证书未通过校验，请配置有效HTTPS证书后重试。");}
            // The default SSL-error behavior cancels; never bypass certificate validation.
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public void onPermissionRequest(PermissionRequest request){runOnUiThread(()->{
                if(destroyed||!sameOrigin(request.getOrigin().toString())||request.getResources().length!=1||!PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(request.getResources()[0])||cameraRequest!=null){request.deny();return;}
                if(ContextCompat.checkSelfPermission(FamilyServerActivity.this,Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED)request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                else{cameraRequest=request;cameraPermission.launch(Manifest.permission.CAMERA);}
            });}
            @Override public void onPermissionRequestCanceled(PermissionRequest request){if(cameraRequest==request)cameraRequest=null;}
            @Override public void onGeolocationPermissionsShowPrompt(String source,GeolocationPermissions.Callback callback){callback.invoke(source,false,false);}
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){
                if(fileCallback!=null)fileCallback.onReceiveValue(null);fileCallback=callback;
                Intent pick=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE,params.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);
                try{filePicker.launch(pick);}catch(Exception error){fileCallback=null;callback.onReceiveValue(null);}return true;
            }
            @Override public boolean onJsAlert(WebView view,String url,String message,JsResult result){new AlertDialog.Builder(FamilyServerActivity.this).setTitle("HeadUp").setMessage(message).setPositiveButton("知道了",(d,w)->result.confirm()).setOnCancelListener(d->result.cancel()).show();return true;}
            @Override public boolean onJsConfirm(WebView view,String url,String message,JsResult result){new AlertDialog.Builder(FamilyServerActivity.this).setTitle("HeadUp").setMessage(message).setPositiveButton("继续",(d,w)->result.confirm()).setNegativeButton("取消",(d,w)->result.cancel()).setOnCancelListener(d->result.cancel()).show();return true;}
        });
        getOnBackPressedDispatcher().addCallback(this,new OnBackPressedCallback(true){@Override public void handleOnBackPressed(){if(web.canGoBack())web.goBack();else confirmClose();}});
        web.loadUrl(origin+"/");
    }
    private void confirmClose(){confirmLeave(()->finish());}
    private void confirmLeave(Runnable action){web.evaluateJavascript("(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented})()",value->{if("true".equals(value))new AlertDialog.Builder(this).setTitle("离开当前页面？").setMessage("页面还有未保存或正在处理的内容，离开可能丢失。已保存的服务器资料仍保留。").setPositiveButton("继续",(d,w)->action.run()).setNegativeButton("继续编辑",null).show();else action.run();});}
    @Override protected void onPause(){if(web!=null)web.onPause();super.onPause();}
    @Override protected void onResume(){super.onResume();if(web!=null)web.onResume();}
    @Override protected void onDestroy(){destroyed=true;if(cameraRequest!=null)cameraRequest.deny();if(fileCallback!=null)fileCallback.onReceiveValue(null);if(exporter!=null)exporter.close();if(web!=null){web.stopLoading();web.destroy();}super.onDestroy();}
}
