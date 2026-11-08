package io.github.rem628.mathbank;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.*;
import android.widget.Toast;
import java.io.*;
import java.net.URL;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Website container with a complete offline snapshot and Android document import/export. */
public final class MainActivity extends Activity {
  private static final String HOME="https://veryblue628.github.io/Rem628.github.io/";
  private static final String BASE_PATH="/Rem628.github.io/";
  private static final String LEGACY_MIGRATION="https://rem628.github.io/__mathbank_migrate.html";
  private static final String NEW_MIGRATION=HOME+"__mathbank_migrate.html";
  private static final String BUNDLE_VERSION="20261108a";
  private volatile String migrationData="{}";
  private volatile boolean migrating=false;
  private WebView web;
  private volatile boolean remote=false;
  private File remoteRelease;
  private ValueCallback<Uri[]> fileCallback;
  private String pendingBackup;

  @Override public void onCreate(Bundle saved) {
    super.onCreate(saved);
    getWindow().setStatusBarColor(0xff1b3b6f);
    getWindow().setNavigationBarColor(0xff1b3b6f);
    web=new WebView(this);setContentView(web);
    WebSettings settings=web.getSettings();
    settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);
    settings.setAllowFileAccess(false);settings.setAllowContentAccess(true);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setBuiltInZoomControls(true);settings.setDisplayZoomControls(false);
    settings.setUseWideViewPort(true);settings.setLoadWithOverviewMode(true);
    settings.setUserAgentString(settings.getUserAgentString()+" MathBankApp/2.7");
    CookieManager.getInstance().setAcceptCookie(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
    web.addJavascriptInterface(new BackupBridge(),"AndroidBackup");
    web.addJavascriptInterface(new MigrationBridge(),"AndroidMigration");
    web.setWebViewClient(new WebViewClient(){
      @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest request){return intercept(request.getUrl(),request.getMethod());}
      @Override public WebResourceResponse shouldInterceptRequest(WebView view,String url){return intercept(Uri.parse(url),"GET");}
      @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){return navigate(request.getUrl());}
      @Override public boolean shouldOverrideUrlLoading(WebView view,String url){return navigate(Uri.parse(url));}
      @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){
        if(request.isForMainFrame())Toast.makeText(MainActivity.this,"页面加载失败，请返回首页重试。本机学习记录仍保留。",Toast.LENGTH_LONG).show();
      }
    });
    web.setWebChromeClient(new WebChromeClient(){
      @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){
        if(fileCallback!=null)fileCallback.onReceiveValue(null);fileCallback=callback;
        Intent pick=new Intent(Intent.ACTION_OPEN_DOCUMENT);pick.addCategory(Intent.CATEGORY_OPENABLE);pick.setType("*/*");
        pick.putExtra(Intent.EXTRA_MIME_TYPES,new String[]{"application/json","text/plain","application/octet-stream"});
        try{startActivityForResult(pick,10);}catch(Exception e){fileCallback.onReceiveValue(null);fileCallback=null;return false;}return true;
      }
    });
    if(Build.VERSION.SDK_INT>=24)ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient(){
      @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request){return intercept(request.getUrl(),request.getMethod());}
    });
    // Start immediately from the bundled release. Only use a newer published compatible release next launch.
    String known=getPreferences(MODE_PRIVATE).getString("remoteVersion","");
    remoteRelease=new File(getFilesDir(),"releases/"+known);
    remote=known.matches("[0-9]{8}[a-z]")&&known.compareTo(BUNDLE_VERSION)>0&&new File(remoteRelease,"complete").isFile();
    if(!getPreferences(MODE_PRIVATE).getBoolean("domainMigrated24",false)){
      migrating=true;web.loadUrl(LEGACY_MIGRATION);
    }else if(saved==null||web.restoreState(saved)==null||!own(Uri.parse(web.getUrl())))web.loadUrl(HOME);
    new Thread(()->{
      try{
        byte[] bytes=readNetwork(new URL(HOME+"version.json?t="+System.currentTimeMillis()),4000);
        String version=new JSONObject(new String(bytes,StandardCharsets.UTF_8)).optString("v","");
        if(version.matches("[0-9]{8}[a-z]")&&version.compareTo(BUNDLE_VERSION)>0)prepareRelease(version);
      }catch(Exception ignored){}
    },"mathbank-version").start();
  }
  // Stage a whole release before activating it on the next launch. Never mix network shell files with an older bundle.
  private void prepareRelease(String version)throws Exception{
    byte[] manifestBytes=readNetwork(new URL(HOME+"offline-manifest.json?v="+version),10000);
    JSONObject manifest=new JSONObject(new String(manifestBytes,StandardCharsets.UTF_8));
    if(!version.equals(manifest.optString("version")))return;
    File staging=new File(getFilesDir(),"releases/"+version);
    if(!staging.isDirectory()&&!staging.mkdirs())throw new IOException("Cannot stage release");
    java.util.LinkedHashSet<String> files=new java.util.LinkedHashSet<>();
    org.json.JSONArray shared=manifest.getJSONObject("shared").getJSONArray("files");
    for(int i=0;i<shared.length();i++){String f=shared.getString(i);if(!f.equals("./"))files.add(f);}
    JSONObject subjects=manifest.getJSONObject("subjects");java.util.Iterator<String> keys=subjects.keys();
    while(keys.hasNext()){org.json.JSONArray list=subjects.getJSONObject(keys.next()).getJSONArray("files");for(int i=0;i<list.length();i++){String f=list.getString(i);if(f.startsWith("q_")&&f.endsWith(".js"))files.add(f);}}
    files.add("offline-manifest.json");
    for(String file:files){if(file.contains("..")||file.contains("\\")||file.startsWith("/")||file.contains(":"))throw new IOException("Invalid release path");
      File destination=new File(staging,file);if(!destination.getParentFile().isDirectory()&&!destination.getParentFile().mkdirs())throw new IOException("Cannot stage directory");
      byte[] bytes=file.equals("offline-manifest.json")?manifestBytes:readNetwork(new URL(HOME+file+"?v="+version),12000);
      try(FileOutputStream out=new FileOutputStream(destination)){out.write(bytes);}
    }
    JSONObject latest=new JSONObject(new String(readNetwork(new URL(HOME+"version.json?t="+System.currentTimeMillis()),5000),StandardCharsets.UTF_8));
    if(!version.equals(latest.optString("v")))return;
    try(FileOutputStream out=new FileOutputStream(new File(staging,"complete"))){out.write(version.getBytes(StandardCharsets.UTF_8));}
    getPreferences(MODE_PRIVATE).edit().putString("remoteVersion",version).apply();
  }
  private boolean own(Uri uri){return "https".equals(uri.getScheme())&&"veryblue628.github.io".equalsIgnoreCase(uri.getHost())&&(uri.getPort()==-1||uri.getPort()==443)&&uri.getPath()!=null&&uri.getPath().startsWith(BASE_PATH);}
  private boolean navigate(Uri uri){
    if(migrating&&LEGACY_MIGRATION.equals(uri.toString()))return false;
    if(own(uri))return false;
    if("https".equals(uri.getScheme())||"http".equals(uri.getScheme()))try{startActivity(new Intent(Intent.ACTION_VIEW,uri));}catch(Exception ignored){}
    return true;
  }
  private byte[] readNetwork(URL url,int timeout)throws Exception{
    HttpURLConnection c=(HttpURLConnection)url.openConnection();c.setConnectTimeout(timeout);c.setReadTimeout(timeout);c.setInstanceFollowRedirects(false);
    try{if(c.getResponseCode()!=200)throw new IOException("HTTP "+c.getResponseCode());try(InputStream in=c.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){
      byte[] buf=new byte[16384];int n;while((n=in.read(buf))!=-1){out.write(buf,0,n);if(out.size()>32*1024*1024)throw new IOException("Resource too large");}return out.toByteArray();
    }}finally{c.disconnect();}
  }
  private WebResourceResponse intercept(Uri uri,String method){
    if(migrating&&"GET".equals(method)&&(LEGACY_MIGRATION.equals(uri.toString())||NEW_MIGRATION.equals(uri.toString())))return migrationPage(LEGACY_MIGRATION.equals(uri.toString()));
    if(!own(uri)||!"GET".equals(method))return null;
    String p="/"+uri.getPath().substring(BASE_PATH.length());if(p.equals("/"))p="/index.html";
    if(p.contains("..")||p.contains("\\"))return response("text/plain",new ByteArrayInputStream(new byte[0]),403);
    // Native assets provide offline support; do not allow a worker to pin an older web release.
    if(p.equals("/sw.js"))return response("text/javascript",new ByteArrayInputStream("self.addEventListener('install',()=>self.registration.unregister());".getBytes(StandardCharsets.UTF_8)),200);
    if(remote){File pinned=new File(remoteRelease,p.substring(1));try{if(pinned.isFile())return response(mime(p),new FileInputStream(pinned),200);}catch(IOException ignored){}}
    if(p.equals("/version.json"))try{return response(mime(p),new ByteArrayInputStream(readNetwork(new URL(uri.toString()),3500)),200);}catch(Exception ignored){}
    try{return response(mime(p),getAssets().open("site"+p),200);}catch(IOException e){return response("text/plain",new ByteArrayInputStream("Resource unavailable".getBytes(StandardCharsets.UTF_8)),404);}
  }
  // Serve both migration pages locally; the retired domain is never contacted.
  private WebResourceResponse migrationPage(boolean exporting){
    String script=exporting
      ?"try{const d={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k.startsWith('NEU-')||k.startsWith('mb_')||k==='sb-pgpaegrihdhynevpyfes-auth-token')d[k]=localStorage.getItem(k)}AndroidMigration.exported(JSON.stringify(d))}catch(e){AndroidMigration.failed()}"
      :"try{const d=JSON.parse(AndroidMigration.payload());for(const k of Object.keys(d)){if(localStorage.getItem(k)===null)localStorage.setItem(k,d[k])}AndroidMigration.imported()}catch(e){AndroidMigration.failed()}";
    String html="<!doctype html><meta charset='utf-8'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; script-src 'unsafe-inline'\"><p>正在保留本机学习记录，请稍候…</p><script>"+script+"</script>";
    return response("text/html",new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)),200);
  }
  public final class MigrationBridge {
    @JavascriptInterface public void exported(String json){runOnUiThread(()->{
      if(!migrating||!LEGACY_MIGRATION.equals(web.getUrl()))return;
      try{if(json==null||json.length()>30*1024*1024)throw new IOException();JSONObject data=new JSONObject(json);java.util.Iterator<String> keys=data.keys();while(keys.hasNext()){String k=keys.next();if(!(k.startsWith("NEU-")||k.startsWith("mb_")||k.equals("sb-pgpaegrihdhynevpyfes-auth-token"))||!(data.get(k) instanceof String))throw new IOException();}migrationData=data.toString();web.loadUrl(NEW_MIGRATION);}catch(Exception e){failed();}
    });}
    @JavascriptInterface public String payload(){return migrating?migrationData:"{}";}
    @JavascriptInterface public void imported(){runOnUiThread(()->{
      if(!migrating||!NEW_MIGRATION.equals(web.getUrl()))return;
      getPreferences(MODE_PRIVATE).edit().putBoolean("domainMigrated24",true).apply();migrationData="{}";migrating=false;web.removeJavascriptInterface("AndroidMigration");web.loadUrl(HOME);
    });}
    @JavascriptInterface public void failed(){runOnUiThread(()->{
      if(!migrating)return;migrationData="{}";migrating=false;web.removeJavascriptInterface("AndroidMigration");Toast.makeText(MainActivity.this,"旧记录迁移未完成，原记录仍保留。请勿卸载，可重启重试或导入备份。",Toast.LENGTH_LONG).show();web.loadUrl(HOME);
    });}
  }
  private String mime(String p){
    if(p.endsWith(".html"))return "text/html";if(p.endsWith(".js"))return "text/javascript";if(p.endsWith(".css"))return "text/css";
    if(p.endsWith(".json"))return "application/json";if(p.endsWith(".png"))return "image/png";if(p.endsWith(".jpg")||p.endsWith(".jpeg"))return "image/jpeg";
    if(p.endsWith(".gif"))return "image/gif";if(p.endsWith(".svg"))return "image/svg+xml";if(p.endsWith(".woff"))return "font/woff";if(p.endsWith(".woff2"))return "font/woff2";return "application/octet-stream";
  }
  private WebResourceResponse response(String mime,InputStream in,int status){
    java.util.Map<String,String> headers=new java.util.HashMap<>();headers.put("Cache-Control","no-cache");headers.put("X-Content-Type-Options","nosniff");
    return new WebResourceResponse(mime,"UTF-8",status,status==200?"OK":"Unavailable",headers,in);
  }
  public final class BackupBridge {
    @JavascriptInterface public void save(String json){
      if(json==null||json.length()>30*1024*1024)return;
      runOnUiThread(()->{
        if(!own(Uri.parse(web.getUrl()))||pendingBackup!=null)return;
        try{JSONObject obj=new JSONObject(json);if(!"mathbank-backup".equals(obj.optString("format"))&&!"mathbank-feedback".equals(obj.optString("format")))return;}catch(Exception e){return;}
        pendingBackup=json;Intent save=new Intent(Intent.ACTION_CREATE_DOCUMENT);save.addCategory(Intent.CATEGORY_OPENABLE);save.setType("application/json");save.putExtra(Intent.EXTRA_TITLE,"数学题库备份-"+new java.text.SimpleDateFormat("yyyy-MM-dd",java.util.Locale.ROOT).format(new java.util.Date())+".json");
        try{startActivityForResult(save,11);}catch(Exception e){pendingBackup=null;Toast.makeText(MainActivity.this,"无法打开文件保存窗口",Toast.LENGTH_LONG).show();}
      });
    }
  }
  @Override protected void onActivityResult(int request,int result,Intent data){
    super.onActivityResult(request,result,data);
    if(request==10&&fileCallback!=null){fileCallback.onReceiveValue(result==RESULT_OK&&data!=null&&data.getData()!=null?new Uri[]{data.getData()}:null);fileCallback=null;}
    if(request==11){String backup=pendingBackup;pendingBackup=null;if(result==RESULT_OK&&data!=null&&data.getData()!=null&&backup!=null){
      final Uri destination=data.getData();new Thread(()->{try(OutputStream out=getContentResolver().openOutputStream(destination,"wt")){out.write(backup.getBytes(StandardCharsets.UTF_8));runOnUiThread(()->Toast.makeText(this,"备份已保存",Toast.LENGTH_LONG).show());}catch(Exception e){runOnUiThread(()->Toast.makeText(this,"备份保存失败，请重新导出",Toast.LENGTH_LONG).show());}},"mathbank-backup").start();
    }}
  }
  @Override public void onBackPressed(){if(web.canGoBack())web.goBack();else super.onBackPressed();}
  @Override protected void onSaveInstanceState(Bundle out){super.onSaveInstanceState(out);web.saveState(out);}
  @Override protected void onPause(){web.onPause();CookieManager.getInstance().flush();super.onPause();}
  @Override protected void onResume(){super.onResume();if(web!=null)web.onResume();}
  @Override protected void onDestroy(){if(fileCallback!=null)fileCallback.onReceiveValue(null);web.removeJavascriptInterface("AndroidBackup");web.removeJavascriptInterface("AndroidMigration");web.destroy();super.onDestroy();}
}
