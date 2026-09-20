# SmartScanCargo

Interface web para leitura sequencial de imagens de raio X e HEMD, criação de bounding boxes na imagem de raio X, reprodução proporcional automática das caixas na imagem HEMD, equalização de histograma no raio X e gravação dos relatórios diretamente na pasta selecionada.

As coordenadas das bounding boxes não são exibidas no campo de edição do relatório. Elas são acrescentadas somente ao arquivo `Relatorio<índice>.txt` no momento da gravação. Após salvar, a interface mostra uma caixa de aviso nativa do navegador com o local do arquivo gerado. Os arquivos CSS e JavaScript usam identificação de versão para impedir que o navegador mantenha a implementação anterior em cache.

Para cada caixa criada, o campo visível recebe uma linha de comentário no formato `BB1: comente ...`, `BB2: comente ...` e assim sucessivamente. Somente o relatório salvo contém a seção `Coordenadas dos BBs`, associando cada índice às suas coordenadas numéricas.

## Senha de acesso

A aplicação abre inicialmente uma tela de acesso. A senha padrão é `123456`. Para alterá-la, edite o arquivo `dist/index.html` e procure pelo comentário `PARA ALTERAR A SENHA`. Modifique somente o valor da constante:

```javascript
const ACCESS_PASSWORD = "0112358";
```

Esta verificação ocorre no navegador e serve apenas como uma barreira simples de acesso; ela não substitui autenticação segura realizada por um servidor.

A versão 7 executa o login de forma independente do código principal, fecha explicitamente a tela de acesso após a senha correta e oferece um botão com ícone de olho para exibir ou ocultar a senha digitada.

## Navegadores compatíveis

Use uma versão atual do Google Chrome ou Microsoft Edge. A aplicação utiliza a File System Access API para ler e gravar na pasta escolhida pelo usuário.

## Estrutura esperada da pasta local

```text
cargas/
├── Imagem1/
│   ├── xray1.png
│   ├── hemd1.png
│   └── InfoSuspeitas1.txt
├── Imagem2/
│   ├── xray2.png
│   ├── hemd2.png
│   └── InfoSuspeitas2.txt
└── ...
```

O arquivo `InfoSuspeitas<índice>.txt` pode utilizar `:` ou `=` para separar chaves e valores. São lidos os campos `suspeito`, `mercadoria_nf`, `des_conteudo` e `mercadoria_manifestada`.

O arquivo `count-images.txt` é criado automaticamente na pasta principal e guarda, com um índice por linha, as imagens cujos relatórios já foram salvos. A pasta do dataset é escolhida pelo campo no cabeçalho e sua autorização é armazenada localmente pelo navegador. Por segurança, o navegador não expõe nem reabre pastas por um caminho Windows digitado; por isso o campo mostra o nome da pasta e pode ser clicado para escolher ou reautorizar o local.

Enquanto nenhuma imagem está carregada, o botão **UpLoad Images** permite escolher `xray<índice>.png` ou `hemd<índice>.png` de uma imagem já analisada. Se a janela for cancelada, o sistema carrega a próxima imagem pendente, ignorando os índices presentes em `count-images.txt`. Depois que uma imagem é carregada, a seleção manual fica desativada e o botão passa a carregar somente a próxima pendente.

Se a pasta ainda não estiver configurada e o usuário clicar em **UpLoad Images**, o sistema solicita primeiro a pasta principal, salva a autorização no navegador e apresenta uma escolha temporária entre reavaliação e próxima pendente. O navegador não permite deduzir automaticamente a pasta-pai a partir de um arquivo isolado.

## Execução local

Por segurança do navegador, execute o projeto por um servidor local. No diretório do projeto:

```bash
python -m http.server 8000 --directory dist
```

Depois, acesse `http://localhost:8000` no Chrome ou Edge.

## Publicação no GitHub Pages

O projeto inclui um workflow de publicação. Crie um repositório, envie todos os arquivos e, nas configurações do GitHub Pages, selecione **GitHub Actions** como origem.

## Relatórios

Ao clicar em **Gerar Relatório**, a aplicação cria a pasta `Relatorios` dentro da pasta principal indicada no cabeçalho. Somente o arquivo `Relatorio<índice>.txt` correspondente à carga atual é criado ou substituído; os demais relatórios são preservados. Depois da gravação, o mesmo índice é incluído em `count-images.txt` e a próxima imagem pendente é carregada automaticamente.

As mensagens de relatório salvo e de conclusão são exibidas em caixas modais com o mesmo padrão visual de **Restaurar Início**. Quando não existem mais imagens pendentes, a caixa avisa o usuário e, após a confirmação, a interface retorna automaticamente ao estado inicial, preservando a pasta do dataset configurada.

O JavaScript também cria essa caixa automaticamente caso o navegador ainda esteja usando uma versão anterior do `index.html`, evitando que uma atualização parcial interrompa o fluxo depois da gravação do relatório.

## Ampliação dos bounding boxes

Com uma imagem carregada, clique com o botão direito dentro de qualquer BB na imagem de Raio-X ou HEMD. O sistema abre uma janela independente contendo somente aquela região. A janela pode ser redimensionada, e o recorte é escalonado proporcionalmente para ocupar o espaço disponível.

Dentro da janela independente, posicione o cursor sobre o recorte e use a roda do mouse para aumentar ou diminuir o zoom. O ponto sob o cursor é usado como referência da ampliação. Um clique duplo restaura o zoom para 100%.

Para examinar áreas que ficaram fora da janela após a ampliação, mantenha o botão esquerdo do mouse pressionado sobre o recorte e arraste a imagem para a esquerda, direita, para cima ou para baixo. O clique duplo também restaura a posição central da imagem.
