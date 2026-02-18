import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { getPansouAuthToken, updatePansouAuthConfig } from '@/lib/pansou-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q');

  if (!query) {
    return NextResponse.json({ error: '搜索关键词不能为空' }, { status: 400 });
  }

  const config = await getConfig();
  const netDiskConfig = config.NetDiskConfig;

  // 检查是否启用网盘搜索 - 必须在缓存检查之前
  if (!netDiskConfig?.enabled) {
    return NextResponse.json({ error: '网盘搜索功能未启用' }, { status: 400 });
  }

  if (!netDiskConfig?.pansouUrl) {
    return NextResponse.json({ error: 'PanSou服务地址未配置' }, { status: 400 });
  }

  // 网盘搜索缓存：30分钟
  const NETDISK_CACHE_TIME = 30 * 60; // 30分钟（秒）
  const enabledCloudTypesStr = (netDiskConfig.enabledCloudTypes || []).sort().join(',');
  // 缓存key包含功能状态，确保功能开启/关闭时缓存隔离
  const cacheKey = `netdisk-search-enabled-${query}-${enabledCloudTypesStr}`;
  
  console.log(`🔍 检查网盘搜索缓存: ${cacheKey}`);
  
  // 服务端直接调用数据库（不用ClientCache，避免HTTP循环调用）
  try {
    const cached = await db.getCache(cacheKey);
    if (cached) {
      console.log(`✅ 网盘搜索缓存命中(数据库): "${query}" (${enabledCloudTypesStr})`);
      return NextResponse.json({
        ...cached,
        fromCache: true,
        cacheSource: 'database',
        cacheTimestamp: new Date().toISOString()
      });
    }
    
    console.log(`❌ 网盘搜索缓存未命中: "${query}" (${enabledCloudTypesStr})`);
  } catch (cacheError) {
    console.warn('网盘搜索缓存读取失败:', cacheError);
    // 缓存失败不影响主流程，继续执行
  }

  try {
    // 准备请求头
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'LunaTV/1.0'
    };

    // 处理认证
    if (netDiskConfig.authEnabled && netDiskConfig.authUsername && netDiskConfig.authPassword) {
      console.log(`🔐 网盘搜索启用认证，用户名: ${netDiskConfig.authUsername}`);
      
      const authResult = await getPansouAuthToken(
        netDiskConfig.pansouUrl,
        netDiskConfig.authUsername,
        netDiskConfig.authPassword
      );

      if ('error' in authResult) {
        console.error('PanSou认证失败:', authResult.message);
        throw new Error(`PanSou认证失败: ${authResult.message}`);
      }

      // 添加认证Token到请求头
      headers['Authorization'] = `Bearer ${authResult.token}`;
      
      // 异步更新配置中的Token信息（不等待）
      updatePansouAuthConfig(authResult.token, authResult.expiresAt, authResult.username)
        .catch(err => console.warn('更新PanSou认证配置失败:', err));
    }

    // 调用PanSou服务
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), (netDiskConfig.timeout || 30) * 1000);

    const pansouResponse = await fetch(`${netDiskConfig.pansouUrl}/api/search`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        kw: query,
        res: 'merge',
        cloud_types: netDiskConfig.enabledCloudTypes || ['baidu', 'aliyun', 'quark', 'tianyi', 'uc']
      })
    });

    clearTimeout(timeout);

    if (!pansouResponse.ok) {
      const errorText = await pansouResponse.text();
      console.error('PanSou服务响应错误:', pansouResponse.status, pansouResponse.statusText, errorText);
      
      // 如果是认证错误，提供更友好的错误信息
      if (pansouResponse.status === 401) {
        throw new Error('PanSou认证失败，请检查用户名和密码是否正确');
      }
      
      throw new Error(`PanSou服务响应错误: ${pansouResponse.status} ${pansouResponse.statusText}`);
    }

    const result = await pansouResponse.json();
    
    // 统一返回格式
    const responseData = {
      success: true,
      data: {
        total: result.data?.total || 0,
        merged_by_type: result.data?.merged_by_type || {},
        source: 'pansou',
        query: query,
        timestamp: new Date().toISOString()
      }
    };

    // 服务端直接保存到数据库（不用ClientCache，避免HTTP循环调用）
    try {
      await db.setCache(cacheKey, responseData, NETDISK_CACHE_TIME);
      console.log(`💾 网盘搜索结果已缓存(数据库): "${query}" - ${responseData.data.total} 个结果, TTL: ${NETDISK_CACHE_TIME}s`);
    } catch (cacheError) {
      console.warn('网盘搜索缓存保存失败:', cacheError);
    }

    console.log(`✅ 网盘搜索完成: "${query}" - ${responseData.data.total} 个结果`);
    return NextResponse.json(responseData);

  } catch (error: any) {
    console.error('网盘搜索失败:', error);
    
    let errorMessage = '网盘搜索失败';
    if (error.name === 'AbortError') {
      errorMessage = '网盘搜索请求超时';
    } else if (error.message) {
      errorMessage = `网盘搜索失败: ${error.message}`;
    }

    return NextResponse.json({ 
      success: false,
      error: errorMessage,
      suggestion: '请检查PanSou服务是否正常运行或联系管理员'
    }, { status: 500 });
  }
}