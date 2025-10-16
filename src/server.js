require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ====== CONFIGURAÇÕES ======
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'vendas';

// Memória de conversas (em produção use Redis)
const conversationMemory = new Map();
const pedidosEmAndamento = new Map();

// ====== FUNÇÕES AUXILIARES ======

function limparTelefone(telefone) {
    // Remove caracteres especiais e adiciona @s.whatsapp.net se necessário
    let limpo = telefone.replace(/\D/g, '');
    if (!limpo.startsWith('55')) limpo = '55' + limpo;
    return limpo.includes('@') ? limpo : limpo + '@s.whatsapp.net';
}

async function isAdmin(telefone) {
    const { data } = await supabase
        .from('admins')
        .select('*')
        .eq('telefone', limparTelefone(telefone))
        .eq('ativo', true)
        .single();
    
    return data !== null;
}

async function salvarConversa(telefone, mensagem, tipo) {
    await supabase.from('conversas').insert({
        telefone: limparTelefone(telefone),
        mensagem,
        tipo
    });
}

// ====== FUNÇÕES WHATSAPP ======

async function enviarMensagem(telefone, mensagem) {
    try {
        await axios.post(
            `${EVOLUTION_API_URL}/message/sendText/${INSTANCE_NAME}`,
            {
                number: limparTelefone(telefone),
                text: mensagem
            },
            {
                headers: {
                    'apikey': EVOLUTION_API_KEY,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (error) {
        console.error('Erro ao enviar mensagem:', error.response?.data || error.message);
    }
}

// ====== COMANDOS ADMIN ======

async function processarComandoAdmin(telefone, mensagem) {
    const comando = mensagem.toLowerCase().trim();
    
    // LISTAR PRODUTOS
    if (comando === '/produtos' || comando === '/lista') {
        const { data: produtos } = await supabase
            .from('produtos')
            .select('*')
            .eq('ativo', true)
            .order('categoria', { ascending: true });
        
        if (!produtos || produtos.length === 0) {
            return '❌ Nenhum produto cadastrado ainda.';
        }
        
        let resposta = '📋 *PRODUTOS CADASTRADOS*\n\n';
        let categoriaAtual = '';
        
        produtos.forEach(p => {
            if (p.categoria !== categoriaAtual) {
                categoriaAtual = p.categoria;
                resposta += `\n*${categoriaAtual.toUpperCase()}*\n`;
            }
            resposta += `\n🆔 ID: ${p.id}\n`;
            resposta += `📦 ${p.nome}\n`;
            resposta += `💰 R$ ${p.preco.toFixed(2)}\n`;
            resposta += `📊 Estoque: ${p.estoque} un\n`;
            resposta += `━━━━━━━━━━━━━━\n`;
        });
        
        resposta += `\n💡 *Comandos disponíveis:*\n`;
        resposta += `/adicionar - Cadastrar produto\n`;
        resposta += `/editar [ID] - Editar produto\n`;
        resposta += `/estoque [ID] [QTD] - Atualizar estoque\n`;
        resposta += `/desativar [ID] - Desativar produto\n`;
        resposta += `/pedidos - Ver pedidos do dia\n`;
        resposta += `/relatorio - Relatório de vendas`;
        
        return resposta;
    }
    
    // ADICIONAR PRODUTO
    if (comando === '/adicionar' || comando === '/add') {
        pedidosEmAndamento.set(telefone, { tipo: 'adicionar_produto', etapa: 1 });
        return '➕ *CADASTRAR NOVO PRODUTO*\n\nEnvie o *nome* do produto:';
    }
    
    // ESTOQUE
    if (comando.startsWith('/estoque ')) {
        const partes = comando.split(' ');
        if (partes.length !== 3) {
            return '❌ Formato correto: /estoque [ID] [QUANTIDADE]\n\nExemplo: /estoque 5 100';
        }
        
        const id = parseInt(partes[1]);
        const quantidade = parseInt(partes[2]);
        
        const { data, error } = await supabase
            .from('produtos')
            .update({ estoque: quantidade, atualizado_em: new Date().toISOString() })
            .eq('id', id)
            .select()
            .single();
        
        if (error || !data) {
            return `❌ Produto ID ${id} não encontrado.`;
        }
        
        return `✅ *Estoque atualizado!*\n\n📦 ${data.nome}\n📊 Novo estoque: ${quantidade} unidades`;
    }
    
    // PEDIDOS DO DIA
    if (comando === '/pedidos') {
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);
        
        const { data: pedidos } = await supabase
            .from('pedidos')
            .select(`
                *,
                itens_pedido (
                    quantidade,
                    produto_nome,
                    subtotal
                )
            `)
            .gte('data_pedido', hoje.toISOString())
            .order('data_pedido', { ascending: false });
        
        if (!pedidos || pedidos.length === 0) {
            return '📭 Nenhum pedido hoje ainda.';
        }
        
        let resposta = `📊 *PEDIDOS DE HOJE* (${pedidos.length})\n\n`;
        
        pedidos.forEach(p => {
            resposta += `🆔 #${p.numero_pedido}\n`;
            resposta += `👤 ${p.cliente_nome}\n`;
            resposta += `📞 ${p.cliente_telefone}\n`;
            resposta += `💰 R$ ${p.total.toFixed(2)}\n`;
            resposta += `📍 Status: ${p.status.toUpperCase()}\n`;
            resposta += `━━━━━━━━━━━━━━\n\n`;
        });
        
        const total = pedidos.reduce((sum, p) => sum + parseFloat(p.total), 0);
        resposta += `💵 *Total do dia:* R$ ${total.toFixed(2)}`;
        
        return resposta;
    }
    
    // RELATÓRIO
    if (comando === '/relatorio' || comando === '/vendas') {
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);
        
        const { data: pedidos } = await supabase
            .from('pedidos')
            .select('total, status')
            .gte('data_pedido', hoje.toISOString());
        
        const total = pedidos?.reduce((sum, p) => sum + parseFloat(p.total), 0) || 0;
        const concluidos = pedidos?.filter(p => p.status === 'concluido').length || 0;
        const pendentes = pedidos?.filter(p => p.status === 'pendente').length || 0;
        
        return `📈 *RELATÓRIO DE HOJE*\n\n` +
               `📦 Total de pedidos: ${pedidos?.length || 0}\n` +
               `✅ Concluídos: ${concluidos}\n` +
               `⏳ Pendentes: ${pendentes}\n` +
               `💰 Faturamento: R$ ${total.toFixed(2)}`;
    }
    
    // AJUDA
    if (comando === '/ajuda' || comando === '/help' || comando === '/comandos') {
        return `🤖 *COMANDOS ADMINISTRATIVOS*\n\n` +
               `📋 /produtos - Lista todos produtos\n` +
               `➕ /adicionar - Cadastrar produto\n` +
               `✏️ /editar [ID] - Editar produto\n` +
               `📊 /estoque [ID] [QTD] - Atualizar estoque\n` +
               `❌ /desativar [ID] - Desativar produto\n` +
               `🛒 /pedidos - Pedidos de hoje\n` +
               `📈 /relatorio - Relatório de vendas\n` +
               `❓ /ajuda - Ver comandos`;
    }
    
    return null; // Não é comando admin válido
}

// ====== PROCESSAMENTO COM IA ======

async function processarMensagemCliente(telefone, mensagem) {
    // Buscar produtos ativos
    const { data: produtos } = await supabase
        .from('produtos')
        .select('*')
        .eq('ativo', true)
        .order('categoria');
    
    // Buscar configurações
    const { data: configs } = await supabase.from('configuracoes').select('*');
    const configMap = {};
    configs?.forEach(c => configMap[c.chave] = c.valor);
    
    // Histórico da conversa
    if (!conversationMemory.has(telefone)) {
        conversationMemory.set(telefone, []);
    }
    const history = conversationMemory.get(telefone);
    history.push({ role: 'user', content: mensagem });
    
    // Montar catálogo
    const catalogo = produtos.map(p => 
        `ID: ${p.id} | ${p.nome} | R$ ${p.preco.toFixed(2)} | Estoque: ${p.estoque} | ${p.descricao || ''}`
    ).join('\n');
    
    const systemPrompt = `Você é um assistente de vendas via WhatsApp super atencioso! 🛍️

**CATÁLOGO DE PRODUTOS:**
${catalogo}

**INFORMAÇÕES DA LOJA:**
- Horário: ${configMap.horario_funcionamento || 'Consulte disponibilidade'}
- Taxa de entrega: R$ ${configMap.taxa_entrega || '0.00'}
- Tempo de entrega: ${configMap.tempo_entrega || '30-40 minutos'}

**SUAS FUNÇÕES:**
1. 🎯 Apresentar produtos de forma atrativa com emojis
2. 💬 Responder dúvidas sobre produtos, preços e disponibilidade
3. 🛒 Ajudar a montar pedidos
4. ✅ Coletar dados para finalizar: nome, endereço completo, forma de pagamento

**REGRAS IMPORTANTES:**
- SEMPRE mencione o ID do produto quando falar dele
- Verifique estoque (se = 0, produto indisponível)
- Seja simpático e use emojis relevantes
- Nunca invente produtos que não estão no catálogo
- Quando cliente quiser finalizar, peça: nome completo, endereço com número/bairro/CEP, forma de pagamento (PIX/Dinheiro/Cartão)

**FORMATO DE CONFIRMAÇÃO:**
"✅ *PEDIDO CONFIRMADO!*
📦 Itens: [lista]
💰 Subtotal: R$ [valor]
🚚 Taxa de entrega: R$ ${configMap.taxa_entrega || '5.00'}
💵 *Total: R$ [valor total]*
📍 Endereço: [endereço completo]
💳 Pagamento: [forma]
⏰ Previsão: ${configMap.tempo_entrega || '40-50 min'}"`;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-12)
    ];
    
    const completion = await openai.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        messages: messages,
        temperature: 0.8,
        max_tokens: 700
    });
    
    const resposta = completion.choices[0].message.content;
    history.push({ role: 'assistant', content: resposta });
    
    if (history.length > 20) {
        conversationMemory.set(telefone, history.slice(-20));
    }
    
    return resposta;
}

// ====== WEBHOOK EVOLUTION API ======

app.post('/webhook', async (req, res) => {
    try {
        const { event, data } = req.body;
        
        if (event !== 'messages.upsert') {
            return res.status(200).json({ status: 'ignored' });
        }
        
        const message = data;
        if (message.key.fromMe) {
            return res.status(200).json({ status: 'ignored' });
        }
        
        const telefone = message.key.remoteJid;
        const texto = message.message?.conversation || 
                     message.message?.extendedTextMessage?.text || '';
        
        if (!texto) {
            return res.status(200).json({ status: 'ignored' });
        }
        
        console.log(`💬 ${telefone}: ${texto}`);
        
        // Salvar mensagem do cliente
        await salvarConversa(telefone, texto, 'cliente');
        
        let resposta;
        
        // Verificar se é admin
        const ehAdmin = await isAdmin(telefone);
        
        if (ehAdmin && texto.startsWith('/')) {
            // Processar comando admin
            resposta = await processarComandoAdmin(telefone, texto);
            if (resposta) {
                await enviarMensagem(telefone, resposta);
                await salvarConversa(telefone, resposta, 'admin');
            } else {
                // Comando não reconhecido
                await enviarMensagem(telefone, '❌ Comando não reconhecido. Use /ajuda para ver comandos disponíveis.');
            }
        } else {
            // Cliente normal - processar com IA
            resposta = await processarMensagemCliente(telefone, texto);
            await enviarMensagem(telefone, resposta);
            await salvarConversa(telefone, resposta, 'bot');
        }
        
        res.status(200).json({ status: 'success' });
        
    } catch (error) {
        console.error('❌ Erro:', error);
        res.status(500).json({ error: error.message });
    }
});

// ====== ROTAS API ======

app.get('/', (req, res) => {
    res.json({ 
        status: 'online',
        message: '🤖 WhatsApp AI Vendas',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// ====== INICIAR SERVIDOR ======

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
