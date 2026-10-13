package com.headup.growth;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AlertDialog;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    ExportController exporter;
    @Override public void onCreate(Bundle state) {
        exporter = new ExportController(this);
        registerPlugin(HeadUpDevicePlugin.class);
        super.onCreate(state);
        getOnBackPressedDispatcher().addCallback(this,new OnBackPressedCallback(true){
            @Override public void handleOnBackPressed(){
                if(getBridge()==null){finish();return;}
                getBridge().getWebView().evaluateJavascript("(()=>{const dialog=document.querySelector('dialog[open]');if(dialog){const event=new Event('cancel',{cancelable:true});dialog.dispatchEvent(event);if(!event.defaultPrevented)dialog.close();return true;}const event=new Event('headup:native-back',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented})()",handled->{
                    if("true".equals(handled))return;
                    if(getBridge().getWebView().canGoBack())getBridge().getWebView().goBack();
                    else getBridge().getWebView().evaluateJavascript("(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented})()",dirty->{
                        if("true".equals(dirty))new AlertDialog.Builder(MainActivity.this).setTitle("退出HeadUp？").setMessage("还有未保存或正在处理的内容，退出可能丢失。").setPositiveButton("退出",(d,w)->finish()).setNegativeButton("继续编辑",null).show();else finish();
                    });
                });
            }
        });
    }
    @Override public void onDestroy() { if (exporter != null) exporter.close(); super.onDestroy(); }
}
