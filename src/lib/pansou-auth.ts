/**
 * PanSou认证管理工具
 * 用于处理PanSou服务的JWT认证
 */

import { getConfig } from './config';

export interface PansouAuthResult {
  token: string;
  expiresAt: number;
  username: string;
}

export interface PansouAuthError {
  error: string;
  message: string;
}

/**
 * 获取PanSou认证Token
 * 如果已存在有效Token，则直接返回；否则重新登录获取
 */
export async function getPansouAuthToken(pansouUrl: string, username: string, password: string): Promise<PansouAuthResult | PansouAuthError> {
  const config = await getConfig();
  const netDiskConfig = config.NetDiskConfig;

  // 检查是否已有有效Token
  if (netDiskConfig?.authToken && netDiskConfig?.tokenExpiry) {
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = netDiskConfig.tokenExpiry - now;
    
    // Token还有5分钟有效期，认为有效
    if (expiresIn > 300) {
      return {
        token: netDiskConfig.authToken,
        expiresAt: netDiskConfig.tokenExpiry,
        username: username
      };
    }
  }

  // 需要重新登录获取Token
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10秒超时

    const loginResponse = await fetch(`${pansouUrl}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LunaTV/1.0'
      },
      signal: controller.signal,
      body: JSON.stringify({
        username,
        password
      })
    });

    clearTimeout(timeout);

    if (!loginResponse.ok) {
      return {
        error: 'AUTH_FAILED',
        message: `登录失败: ${loginResponse.status} ${loginResponse.statusText}`
      };
    }

    const result = await loginResponse.json();
    
    if (!result.token) {
      return {
        error: 'AUTH_FAILED',
        message: '登录响应中缺少Token'
      };
    }

    // 计算Token过期时间（假设expires_at是秒级时间戳）
    const expiresAt = result.expires_at || Math.floor(Date.now() / 1000) + 24 * 3600; // 默认24小时

    return {
      token: result.token,
      expiresAt,
      username: result.username || username
    };

  } catch (error: any) {
    console.error('PanSou认证失败:', error);
    
    let errorMessage = 'PanSou认证失败';
    if (error.name === 'AbortError') {
      errorMessage = 'PanSou认证请求超时';
    } else if (error.message) {
      errorMessage = `PanSou认证失败: ${error.message}`;
    }

    return {
      error: 'AUTH_ERROR',
      message: errorMessage
    };
  }
}

/**
 * 验证PanSou Token是否有效
 */
export async function verifyPansouToken(pansouUrl: string, token: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5秒超时

    const verifyResponse = await fetch(`${pansouUrl}/api/auth/verify`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'LunaTV/1.0'
      },
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!verifyResponse.ok) {
      return false;
    }

    const result = await verifyResponse.json();
    return result.valid === true;

  } catch (error) {
    console.error('PanSou Token验证失败:', error);
    return false;
  }
}

/**
 * 更新配置中的认证信息
 */
export async function updatePansouAuthConfig(token: string, expiresAt: number, username: string): Promise<void> {
  try {
    const response = await fetch('/api/admin/netdisk/auth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        authToken: token,
        tokenExpiry: expiresAt,
        authUsername: username
      })
    });

    if (!response.ok) {
      console.error('更新PanSou认证配置失败:', response.statusText);
    }
  } catch (error) {
    console.error('更新PanSou认证配置失败:', error);
  }
}